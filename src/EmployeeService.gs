/**
 * EmployeeService.gs
 * ---------------------------------------------------------------------------
 * Employee management (ADMIN). Employees are never hard-deleted: they are
 * DISABLED instead so historical orders keep their references.
 */

var EMPLOYEE_STATUS = ['ACTIVE', 'DISABLED'];

/**
 * Returns an employee object safe for the client (never includes pin_hash).
 * @param {Object} emp
 * @param {boolean=} forCache include fields needed by session validation
 */
function publicEmployee(emp, forCache) {
  var out = {
    employee_id: emp.employee_id,
    employee_code: emp.employee_code,
    name: emp.name,
    department: emp.department,
    role: emp.role,
    status: emp.status,
    must_change_pin: toBool(emp.must_change_pin)
  };
  if (!forCache) {
    out.last_login = emp.last_login;
    out.created_at = emp.created_at;
    out.updated_at = emp.updated_at;
    out.locked = !!(emp.locked_until && emp.locked_until > nowStr());
    out.is_sample = toBool(emp.is_sample);
  }
  return out;
}

/** Generates a random non-trivial 6-digit PIN. */
function generatePin() {
  for (var i = 0; i < 20; i++) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    var digits = '';
    for (var j = 0; j < hex.length && digits.length < 6; j++) {
      var n = parseInt(hex.charAt(j), 16);
      if (n < 10) digits += n;
    }
    if (digits.length < 6) continue;
    try { validatePinFormat(digits); return digits; } catch (e) { /* retry */ }
  }
  return '482913';
}

/**
 * Lists employees with optional filters.
 * @param {Object} user
 * @param {{q:string, department:string, role:string, status:string}} p
 */
function listEmployees(user, p) {
  p = p || {};
  var q = String(p.q || '').trim().toLowerCase();
  var rows = dbAll('EMPLOYEES').filter(function (e) {
    if (p.department && e.department !== p.department) return false;
    if (p.role && e.role !== p.role) return false;
    if (p.status && e.status !== p.status) return false;
    if (q) {
      var hay = (e.employee_code + ' ' + e.name + ' ' + e.department).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }).map(function (e) { return publicEmployee(e); });
  rows.sort(function (a, b) { return a.employee_code < b.employee_code ? -1 : 1; });
  return { rows: rows, total: rows.length, departments: cfgList('DEPARTMENTS'), roles: ALL_ROLES };
}

/** Validates common employee fields. */
function validateEmployeeInput_(p) {
  var name = sanitizeText(p.name, 100);
  assert(name.length >= 2, 'VALIDATION_ERROR', 'กรุณากรอกชื่อพนักงาน');
  var dept = sanitizeText(p.department, 50);
  assert(dept, 'VALIDATION_ERROR', 'กรุณาเลือกแผนก');
  var role = String(p.role || ROLE.EMPLOYEE).toUpperCase();
  assert(ALL_ROLES.indexOf(role) >= 0, 'VALIDATION_ERROR', 'Role ไม่ถูกต้อง');
  return { name: name, department: dept, role: role };
}

/** Ensures at least one other active admin remains when changing an admin. */
function assertNotLastAdmin_(emp, newRole, newStatus) {
  if (emp.role !== ROLE.ADMIN || emp.status !== 'ACTIVE') return;
  if (newRole === ROLE.ADMIN && newStatus === 'ACTIVE') return;
  var others = dbAll('EMPLOYEES').filter(function (e) {
    return e.employee_id !== emp.employee_id && e.role === ROLE.ADMIN && e.status === 'ACTIVE';
  });
  assert(others.length > 0, 'VALIDATION_ERROR', 'ต้องมีผู้ดูแลระบบ (ADMIN) ที่ใช้งานอยู่อย่างน้อย 1 คน');
}

/**
 * Creates or updates an employee.
 * @param {Object} user
 * @param {{employee_id?:string, employee_code:string, name:string, department:string, role:string, pin?:string}} p
 * @return {{employee:Object, generatedPin?:string}}
 */
function saveEmployee(user, p) {
  p = p || {};
  var input = validateEmployeeInput_(p);
  return withLock(function () {
    var now = nowStr();
    if (p.employee_id) {
      var emp = dbFindOne('EMPLOYEES', 'employee_id', String(p.employee_id));
      assert(emp, 'NOT_FOUND', 'ไม่พบพนักงาน');
      assertNotLastAdmin_(emp, input.role, emp.status);
      var before = publicEmployee(emp);
      var changes = { name: input.name, department: input.department, role: input.role, updated_at: now };
      var d = diffFields(emp, changes, ['name', 'department', 'role']);
      dbUpdate('EMPLOYEES', emp, changes);
      if (before.role !== input.role) revokeAllSessions(emp.employee_id);
      invalidateEmployeeCache(emp.employee_id);
      if (d.changed) writeAudit(user, 'UPDATE_EMPLOYEE', 'EMPLOYEE', emp.employee_code, d.old, d.new);
      return { employee: publicEmployee(emp) };
    }
    var code = normalizeEmployeeCode(p.employee_code);
    assert(!dbFindOne('EMPLOYEES', 'employee_code', code), 'DUPLICATE_CODE', 'รหัสพนักงาน ' + code + ' มีอยู่แล้ว');
    var pin = p.pin ? validatePinFormat(p.pin) : generatePin();
    var row = dbInsert('EMPLOYEES', {
      employee_id: uuid(),
      employee_code: code,
      name: input.name,
      department: input.department,
      role: input.role,
      pin_hash: hashPin(pin),
      status: 'ACTIVE',
      must_change_pin: 'TRUE',
      failed_attempts: 0,
      locked_until: '',
      created_at: now,
      updated_at: now,
      last_login: '',
      is_sample: 'FALSE'
    });
    writeAudit(user, 'CREATE_EMPLOYEE', 'EMPLOYEE', code, '', { name: input.name, department: input.department, role: input.role });
    return { employee: publicEmployee(row), generatedPin: p.pin ? '' : pin };
  });
}

/**
 * Enables / disables an employee. Disabling revokes all sessions.
 * @param {{employee_id:string, status:string}} p
 */
function setEmployeeStatus(user, p) {
  var status = String(p && p.status || '').toUpperCase();
  assert(EMPLOYEE_STATUS.indexOf(status) >= 0, 'VALIDATION_ERROR', 'สถานะไม่ถูกต้อง');
  return withLock(function () {
    var emp = dbFindOne('EMPLOYEES', 'employee_id', String(p.employee_id || ''));
    assert(emp, 'NOT_FOUND', 'ไม่พบพนักงาน');
    assert(!(emp.employee_id === user.employee_id && status === 'DISABLED'), 'VALIDATION_ERROR',
      'ไม่สามารถระงับบัญชีของตัวเองได้');
    assertNotLastAdmin_(emp, emp.role, status);
    var old = emp.status;
    dbUpdate('EMPLOYEES', emp, { status: status, updated_at: nowStr() });
    if (status === 'DISABLED') revokeAllSessions(emp.employee_id);
    invalidateEmployeeCache(emp.employee_id);
    writeAudit(user, status === 'DISABLED' ? 'DISABLE_EMPLOYEE' : 'ENABLE_EMPLOYEE', 'EMPLOYEE', emp.employee_code, old, status);
    return { employee: publicEmployee(emp) };
  });
}

/**
 * Resets an employee PIN (optionally to a given PIN) and forces a PIN change.
 * @param {{employee_id:string, pin?:string}} p
 * @return {{employee:Object, generatedPin:string}}
 */
function resetEmployeePin(user, p) {
  p = p || {};
  var pin = p.pin ? validatePinFormat(p.pin) : generatePin();
  var emp = dbFindOne('EMPLOYEES', 'employee_id', String(p.employee_id || ''));
  assert(emp, 'NOT_FOUND', 'ไม่พบพนักงาน');
  dbUpdate('EMPLOYEES', emp, {
    pin_hash: hashPin(pin), must_change_pin: 'TRUE', failed_attempts: 0, locked_until: '', updated_at: nowStr()
  });
  revokeAllSessions(emp.employee_id);
  writeAudit(user, 'RESET_PIN', 'EMPLOYEE', emp.employee_code, '', 'PIN reset');
  return { employee: publicEmployee(emp), generatedPin: pin };
}

/** Minimal RFC4180 CSV parser. @return {Array<Array<string>>} */
function parseCsv(text) {
  var rows = [], row = [], cur = '', inQ = false;
  var s = String(text || '').replace(/^﻿/, '');
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (inQ) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s.charAt(i + 1) === '\n') i++;
      row.push(cur); cur = '';
      if (row.join('').trim() !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.join('').trim() !== '') rows.push(row);
  return rows;
}

/**
 * Imports employees from CSV: employee_code,name,department,role[,pin]
 * Existing codes are skipped (never overwritten).
 * @param {{csv:string}} p
 */
function importEmployeesCsv(user, p) {
  var rows = parseCsv(p && p.csv);
  assert(rows.length > 0, 'VALIDATION_ERROR', 'ไฟล์ CSV ว่างเปล่า');
  assert(rows.length <= 1001, 'VALIDATION_ERROR', 'นำเข้าได้สูงสุด 1,000 รายการต่อครั้ง');
  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var hasHeader = header.indexOf('employee_code') >= 0 || header.indexOf('name') >= 0;
  var idx = hasHeader ? {
    code: header.indexOf('employee_code'), name: header.indexOf('name'),
    dept: header.indexOf('department'), role: header.indexOf('role'), pin: header.indexOf('pin')
  } : { code: 0, name: 1, dept: 2, role: 3, pin: 4 };
  assert(idx.code >= 0 && idx.name >= 0, 'VALIDATION_ERROR', 'CSV ต้องมีคอลัมน์ employee_code และ name');
  var data = hasHeader ? rows.slice(1) : rows;

  return withLock(function () {
    var existing = {};
    dbAll('EMPLOYEES').forEach(function (e) { existing[e.employee_code] = true; });
    var now = nowStr();
    var toInsert = [], created = [], skipped = [], errors = [];
    data.forEach(function (r, i) {
      var line = i + (hasHeader ? 2 : 1);
      try {
        var code = normalizeEmployeeCode(r[idx.code]);
        if (existing[code]) { skipped.push(code); return; }
        var input = validateEmployeeInput_({
          name: r[idx.name], department: idx.dept >= 0 ? r[idx.dept] : 'Production',
          role: idx.role >= 0 && r[idx.role] ? r[idx.role] : ROLE.EMPLOYEE
        });
        var rawPin = idx.pin >= 0 ? String(r[idx.pin] || '').trim() : '';
        var pin = rawPin ? validatePinFormat(rawPin) : generatePin();
        existing[code] = true;
        toInsert.push({
          employee_id: uuid(), employee_code: code, name: input.name, department: input.department,
          role: input.role, pin_hash: hashPin(pin), status: 'ACTIVE', must_change_pin: 'TRUE',
          failed_attempts: 0, locked_until: '', created_at: now, updated_at: now, last_login: '', is_sample: 'FALSE'
        });
        created.push({ employee_code: code, name: input.name, pin: rawPin ? '(ตามไฟล์)' : pin });
      } catch (e) {
        errors.push({ line: line, message: e.message || String(e) });
      }
    });
    dbInsertMany('EMPLOYEES', toInsert);
    writeAudit(user, 'IMPORT_EMPLOYEES', 'EMPLOYEE', '', '', { created: created.length, skipped: skipped.length, errors: errors.length });
    return { created: created, skipped: skipped, errors: errors };
  });
}

/* ------------------------------------------------------------------------- */
/* Employee app (mobile) home                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Data for the employee home / menu screen.
 * Includes today's (and tomorrow's) meal windows, the selected window's menu
 * and the user's orders in that window.
 * @param {{window_id?:string}} p
 */
function getEmployeeHome(user, p) {
  p = p || {};
  var today = todayStr();
  try { ensureWindowsForDate(today); } catch (e) { logError(e, 'EMPLOYEE', 'ensureWindowsForDate'); }
  var now = nowStr();
  var tomorrow = addDays(today, 1);
  var todays = getWindowsByDate(today);
  var upcoming = todays.filter(function (w) { return computeWindowStatus(w, now) !== WINDOW_STATUS.COMPLETED; })
    .concat(getWindowsByDate(tomorrow));
  var list = upcoming.length ? upcoming : todays;
  var selected = null;
  if (p.window_id) selected = list.filter(function (w) { return w.window_id === p.window_id; })[0] || null;
  if (!selected) selected = pickCurrentWindow(list, now);

  var menu = [], myOrders = [];
  if (selected) {
    var master = indexBy(getMenuMaster(), 'item_id');
    menu = getDailyMenuRows(selected.window_id)
      .filter(function (d) { return d.status !== 'DISABLED'; })
      .map(function (d) { return dailyMenuToClient(d, master); });
    myOrders = dbFind('ORDERS', 'employee_id', user.employee_id, { last: 10 })
      .filter(function (o) { return o.window_id === selected.window_id; })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
      .map(function (o) { return orderToClient(o, selected); });
  }
  return {
    user: user,
    app: getPublicAppInfo(),
    windows: list.map(function (w) { return windowToClient(w, now); }),
    window: selected ? windowToClient(selected, now) : null,
    menu: menu,
    myOrders: myOrders,
    serverTime: now
  };
}

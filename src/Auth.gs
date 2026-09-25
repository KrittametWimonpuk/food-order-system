/**
 * Auth.gs
 * ---------------------------------------------------------------------------
 * Employee ID + PIN authentication with rate limiting and account lockout.
 */

var LOGIN_RATE_WINDOW_SEC = 600;
var LOGIN_RATE_MAX = 10;

/** Normalises and validates an employee code. */
function normalizeEmployeeCode(code) {
  var c = String(code || '').trim().toUpperCase();
  assert(/^[A-Z0-9_\-]{2,20}$/.test(c), 'AUTH_INVALID');
  return c;
}

/** Increments a counter in cache; returns the new value. */
function bumpCounter_(key, ttl) {
  var n = (cacheGet(key) || 0) + 1;
  cachePut(key, n, ttl);
  return n;
}

/**
 * Login with employee code + PIN.
 * @param {{employeeCode:string, pin:string, remember:boolean, userAgent:string}} p
 * @return {{token:string, expiresAt:string, user:Object}}
 */
function authLogin(p) {
  p = p || {};
  var code = normalizeEmployeeCode(p.employeeCode);
  var pin = String(p.pin || '');
  assert(/^\d{4,8}$/.test(pin), 'AUTH_INVALID');

  var rlKey = 'rl_login_' + code;
  var attempts = cacheGet(rlKey) || 0;
  if (attempts >= LOGIN_RATE_MAX) fail('AUTH_RATE_LIMIT');

  var emp = dbFindOne('EMPLOYEES', 'employee_code', code);
  var now = nowStr();
  if (!emp) {
    bumpCounter_(rlKey, LOGIN_RATE_WINDOW_SEC);
    fail('AUTH_INVALID');
  }
  if (emp.locked_until && emp.locked_until > now) {
    var mins = Math.ceil(diffMs(now, emp.locked_until) / 60000);
    fail('AUTH_LOCKED', ERR.AUTH_LOCKED + ' (อีกประมาณ ' + mins + ' นาที)');
  }
  if (!verifyPin(pin, emp.pin_hash)) {
    bumpCounter_(rlKey, LOGIN_RATE_WINDOW_SEC);
    var max = Math.max(3, cfgInt('LOGIN_MAX_ATTEMPTS', 5));
    var failed = toInt(emp.failed_attempts) + 1;
    var changes = { failed_attempts: failed, updated_at: now };
    var msg = ERR.AUTH_INVALID;
    if (failed >= max) {
      changes.failed_attempts = 0;
      changes.locked_until = addMinutes(now, Math.max(1, cfgInt('LOGIN_LOCK_MINUTES', 15)));
      msg = ERR.AUTH_LOCKED + ' ' + cfgInt('LOGIN_LOCK_MINUTES', 15) + ' นาที';
      writeAudit({ employee_id: emp.employee_id, employee_code: emp.employee_code, role: emp.role },
        'ACCOUNT_LOCKED', 'AUTH', emp.employee_id, '', 'locked_until=' + changes.locked_until);
    } else {
      msg += ' (เหลืออีก ' + (max - failed) + ' ครั้ง)';
    }
    dbUpdate('EMPLOYEES', emp, changes);
    fail(failed >= max ? 'AUTH_LOCKED' : 'AUTH_INVALID', msg);
  }
  if (emp.status !== 'ACTIVE') fail('EMPLOYEE_DISABLED');

  dbUpdate('EMPLOYEES', emp, { failed_attempts: 0, locked_until: '', last_login: now });
  cacheRemove(rlKey);
  invalidateEmployeeCache(emp.employee_id);
  var sess = createSession(emp, !!p.remember, p.userAgent);
  var user = publicEmployee(emp);
  writeAudit(user, 'LOGIN', 'AUTH', emp.employee_id, '', p.remember ? 'remember' : '');
  return { token: sess.token, expiresAt: sess.expiresAt, user: user };
}

/** Logout: revokes the current session. */
function authLogout(user, p, ctx) {
  revokeSession(ctx.token);
  writeAudit(user, 'LOGOUT', 'AUTH', user.employee_id, '', '');
  return { loggedOut: true };
}

/** Returns the current user + public app settings. */
function authMe(user) {
  return { user: user, app: getPublicAppInfo() };
}

/**
 * Changes the current user's PIN.
 * @param {Object} user
 * @param {{currentPin:string, newPin:string}} p
 */
function authChangePin(user, p) {
  p = p || {};
  var emp = dbFindOne('EMPLOYEES', 'employee_id', user.employee_id);
  assert(emp, 'NOT_FOUND');
  assert(verifyPin(String(p.currentPin || ''), emp.pin_hash), 'AUTH_INVALID', 'PIN ปัจจุบันไม่ถูกต้อง');
  var newPin = validatePinFormat(p.newPin);
  assert(newPin !== String(p.currentPin), 'VALIDATION_ERROR', 'PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม');
  dbUpdate('EMPLOYEES', emp, { pin_hash: hashPin(newPin), must_change_pin: 'FALSE', updated_at: nowStr() });
  revokeAllSessions(emp.employee_id, user.session_id);
  writeAudit(user, 'CHANGE_PIN', 'AUTH', emp.employee_id, '', '');
  return { changed: true };
}

/**
 * "Forgot PIN" request: notifies admins through the notification queue.
 * Always returns the same response to avoid leaking which codes exist.
 */
function authForgotPin(p) {
  p = p || {};
  var generic = { requested: true, message: 'ส่งคำขอรีเซ็ต PIN ไปยังผู้ดูแลระบบแล้ว กรุณาติดต่อฝ่ายบุคคล/Admin' };
  var code;
  try { code = normalizeEmployeeCode(p.employeeCode); } catch (e) { return generic; }
  var key = 'rl_forgot_' + code;
  if (bumpCounter_(key, 3600) > 3) return generic;
  var emp = dbFindOne('EMPLOYEES', 'employee_code', code);
  if (emp && emp.status === 'ACTIVE') {
    systemLog('INFO', 'AUTH', 'PIN_RESET_REQUEST', 'ขอรีเซ็ต PIN: ' + code, { employee_id: emp.employee_id });
    try {
      enqueueNotification(NOTI_TYPE.PIN_RESET_REQUEST,
        '🔑 คำขอรีเซ็ต PIN\n\nรหัส: ' + emp.employee_code + '\nชื่อ: ' + emp.name + '\nแผนก: ' +
        emp.department + '\nเวลา: ' + thaiDateTime(nowStr()) + '\n\nกรุณารีเซ็ต PIN ในหน้า จัดการพนักงาน',
        'pinreset_' + emp.employee_id + '_' + todayStr());
    } catch (e) { logError(e, 'AUTH', 'authForgotPin', emp.employee_id); }
  }
  return generic;
}

/** Public, non-sensitive app information for the client. */
function getPublicAppInfo() {
  var info = {
    appName: APP.NAME,
    version: APP.VERSION,
    companyName: cfg('COMPANY_NAME') || 'โรงงาน ABC',
    timezone: APP.TIMEZONE,
    serverTime: nowStr(),
    maxQtyPerOrder: cfgInt('MAX_QTY_PER_ORDER', 3),
    allowEdit: cfgBool('ALLOW_EDIT'),
    allowCancel: cfgBool('ALLOW_CANCEL'),
    allowMultipleOrders: cfgBool('ALLOW_MULTIPLE_ORDERS'),
    pinMinLength: Math.max(4, cfgInt('PIN_MIN_LENGTH', 4)),
    departments: cfgList('DEPARTMENTS'),
    categories: cfgList('MENU_CATEGORIES')
  };
  return info;
}

/** "25 กันยายน 2026 10:30 น." */
function thaiDateTime(s) {
  return thaiDate(s) + ' ' + hhmm(s) + ' น.';
}

/**
 * AdminService.gs
 * ---------------------------------------------------------------------------
 * Admin dashboard, system settings, system health and sample-data cleanup.
 */

/**
 * Admin / viewer dashboard.
 * @param {{days?:number}} p
 */
function getAdminDashboard(user, p) {
  p = p || {};
  var today = todayStr();
  try { ensureWindowsForDate(today); } catch (e) { logError(e, 'ADMIN', 'ensureWindowsForDate'); }
  var days = Math.min(60, Math.max(7, toInt(p.days, 14)));
  var from = addDays(today, -(days - 1));
  var orders = getOrdersByDateRange(from, today);
  var todayOrders = orders.filter(function (o) { return o.order_date === today; });
  var aggToday = aggregateOrders(todayOrders);
  var aggRange = aggregateOrders(orders);
  var now = nowStr();
  var employees = dbAll('EMPLOYEES');
  var activeEmp = employees.filter(function (e) { return e.status === 'ACTIVE'; }).length;
  var orderedToday = {};
  todayOrders.forEach(function (o) { if (o.status !== ORDER_STATUS.CANCELLED) orderedToday[o.employee_id] = true; });
  var out = {
    date: today,
    date_th: thaiDate(today),
    windows: getWindowsByDate(today).map(function (w) { return windowToClient(w, now); }),
    kpi: aggToday.kpi,
    byMenu: aggToday.byMenu,
    byDepartment: aggToday.byDepartment,
    trend: fillDateGaps_(aggRange.byDate, from, today),
    employees: { total: employees.length, active: activeEmp, orderedToday: Object.keys(orderedToday).length },
    recent: todayOrders.slice(-8).reverse().map(function (o) { return orderToClient(o, null); }),
    serverTime: now
  };
  if (user.role === ROLE.ADMIN) out.health = getSystemHealth_();
  return out;
}

/** Setup / health checks shown on the admin dashboard. */
function getSystemHealth_() {
  var warnings = [];
  var line = getLineConfig();
  if (!line.token || !line.target) warnings.push({ level: 'warning', text: 'ยังไม่ได้ตั้งค่า LINE Messaging API (Token / Target ID)', page: 'line' });
  var triggers = [];
  try { triggers = getTriggerInfo_(); } catch (e) { /* no scope */ }
  var missing = TRIGGER_HANDLERS.filter(function (h) { return !triggers.some(function (t) { return t.handler === h; }); });
  if (missing.length) warnings.push({ level: 'warning', text: 'ยังไม่ได้ติดตั้ง Trigger: ' + missing.join(', '), page: 'settings' });
  var failed = 0;
  try {
    failed = getRecentNotifications_(200).filter(function (n) { return n.status === NOTI_STATUS.FAILED; }).length;
  } catch (e) { /* ignore */ }
  if (failed) warnings.push({ level: 'danger', text: 'มีข้อความ LINE ส่งไม่สำเร็จ ' + failed + ' รายการ', page: 'line' });
  var errorsToday = 0;
  try {
    var sh = getTableSheet('ERROR_LOG');
    var last = sh.getLastRow();
    if (last > 1) {
      var today = todayStr();
      errorsToday = dbReadBlock_('ERROR_LOG', Math.max(2, last - 200), last)
        .filter(function (r) { return String(r.timestamp).substring(0, 10) === today; }).length;
    }
  } catch (e) { /* ignore */ }
  if (errorsToday) warnings.push({ level: 'danger', text: 'มี Error วันนี้ ' + errorsToday + ' รายการ', page: 'logs' });
  return {
    warnings: warnings,
    schedulerLastRun: getScriptProp('SCHEDULER_LAST_RUN'),
    lineConnected: !!(line.token && line.target),
    errorsToday: errorsToday,
    failedNotifications: failed
  };
}

/** Settings page data. */
function getSettings(user) {
  var map = getConfigMap();
  var descs = {};
  DEFAULT_CONFIG.forEach(function (r) { descs[r[0]] = r[2]; });
  dbAll('CONFIG').forEach(function (r) { if (r.description) descs[r.key] = r.description; });
  var items = Object.keys(EDITABLE_CONFIG).map(function (k) {
    return { key: k, value: map[k] === undefined ? '' : String(map[k]), type: EDITABLE_CONFIG[k], description: descs[k] || '' };
  });
  var props = {};
  Object.keys(PROP).forEach(function (k) { props[k] = !!getScriptProp(PROP[k]); });
  var triggers = null;
  try { triggers = getTriggerStatus(user); } catch (e) { triggers = { installed: [], missing: TRIGGER_HANDLERS, error: String(e.message || e) }; }
  return { items: items, timezone: APP.TIMEZONE, scriptProperties: props, triggers: triggers, version: APP.VERSION };
}

/** Validates one setting value by type. */
function validateSetting_(key, type, raw) {
  var v = String(raw === null || raw === undefined ? '' : raw).trim();
  switch (type) {
    case 'bool': return toBool(v) ? 'TRUE' : 'FALSE';
    case 'int':
      assert(/^\d{1,6}$/.test(v), 'VALIDATION_ERROR', key + ' ต้องเป็นตัวเลข');
      if (key === 'MAX_QTY_PER_ORDER') assert(toInt(v) >= 0 && toInt(v) <= 100, 'VALIDATION_ERROR', 'จำนวนสูงสุดต่อ Order ต้องอยู่ระหว่าง 0-100 (0 = ไม่จำกัด)');
      if (key === 'SUMMARY_INTERVAL_MINUTES') assert(toInt(v) >= 5, 'VALIDATION_ERROR', 'ช่วงเวลาสรุปต้องไม่น้อยกว่า 5 นาที');
      if (key === 'SESSION_TIMEOUT_MINUTES') assert(toInt(v) >= 5, 'VALIDATION_ERROR', 'Session timeout ต้องไม่น้อยกว่า 5 นาที');
      if (key === 'PIN_MIN_LENGTH') assert(toInt(v) >= 4 && toInt(v) <= 8, 'VALIDATION_ERROR', 'ความยาว PIN ต้องอยู่ระหว่าง 4-8');
      if (key === 'LOGIN_MAX_ATTEMPTS') assert(toInt(v) >= 3, 'VALIDATION_ERROR', 'จำนวนครั้งต้องไม่น้อยกว่า 3');
      return String(toInt(v));
    case 'time':
      var t = normalizeTime(v);
      assert(t, 'VALIDATION_ERROR', key + ' รูปแบบเวลาไม่ถูกต้อง (HH:mm)');
      return t;
    case 'hour':
      assert(/^\d{1,2}$/.test(v) && toInt(v) <= 23, 'VALIDATION_ERROR', 'ชั่วโมงต้องอยู่ระหว่าง 0-23');
      return String(toInt(v));
    case 'interval':
      assert(VALID_INTERVALS.indexOf(toInt(v)) >= 0, 'VALIDATION_ERROR', 'Scheduler ต้องเป็น 1, 5, 10, 15 หรือ 30 นาที');
      return String(toInt(v));
    case 'notimode':
      assert(NOTIFICATION_MODES.indexOf(v.toUpperCase()) >= 0, 'VALIDATION_ERROR', 'โหมดแจ้งเตือนไม่ถูกต้อง');
      return v.toUpperCase();
    case 'meals':
      var meals = v.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(String);
      meals.forEach(function (m) { assert(MEAL_TYPES.indexOf(m) >= 0, 'VALIDATION_ERROR', 'มื้อไม่ถูกต้อง: ' + m); });
      return meals.join(',');
    case 'days':
      var days = v.split(',').map(function (s) { return s.trim(); }).filter(String);
      days.forEach(function (d) { assert(/^[0-6]$/.test(d), 'VALIDATION_ERROR', 'วันทำงานต้องเป็นตัวเลข 0-6'); });
      return days.join(',');
    case 'list':
      var items = v.split(',').map(function (s) { return sanitizeText(s, 50); }).filter(String);
      assert(items.length > 0, 'VALIDATION_ERROR', key + ' ต้องมีอย่างน้อย 1 รายการ');
      return items.join(',');
    default:
      var s = sanitizeText(v, 200);
      assert(s, 'VALIDATION_ERROR', key + ' ต้องไม่ว่าง');
      return s;
  }
}

/**
 * Saves settings (only EDITABLE_CONFIG keys).
 * @param {{values:Object<string,string>}} p
 */
function saveSettings(user, p) {
  var values = (p && p.values) || {};
  var clean = {};
  Object.keys(values).forEach(function (k) {
    assert(EDITABLE_CONFIG[k], 'VALIDATION_ERROR', 'ไม่สามารถแก้ไข ' + k);
    clean[k] = validateSetting_(k, EDITABLE_CONFIG[k], values[k]);
  });
  var changed = withLock(function () {
    var rows = indexBy(dbAll('CONFIG'), 'key');
    var now = nowStr();
    var updates = [], inserts = [], diffs = [];
    var descs = {};
    DEFAULT_CONFIG.forEach(function (r) { descs[r[0]] = r[2]; });
    Object.keys(clean).forEach(function (k) {
      var row = rows[k];
      if (row) {
        if (String(row.value) === clean[k]) return;
        diffs.push({ key: k, old: row.value, new: clean[k] });
        updates.push({ row: row, changes: { value: clean[k], updated_at: now, updated_by: user.employee_code } });
      } else {
        diffs.push({ key: k, old: '', new: clean[k] });
        inserts.push({ key: k, value: clean[k], description: descs[k] || '', updated_at: now, updated_by: user.employee_code });
      }
    });
    dbUpdateMany('CONFIG', updates);
    dbInsertMany('CONFIG', inserts);
    return diffs;
  });
  invalidateConfig();
  changed.forEach(function (d) { writeAudit(user, 'UPDATE_SETTING', 'SETTINGS', d.key, d.old, d.new); });
  var needTriggers = changed.some(function (d) { return d.key === 'SCHEDULER_INTERVAL_MINUTES' || d.key === 'BACKUP_HOUR'; });
  var triggerMsg = '';
  if (needTriggers) {
    try { setupTriggers(); triggerMsg = 'ติดตั้ง Trigger ใหม่แล้ว'; } catch (e) { triggerMsg = 'กรุณารัน setupTriggers() ใหม่'; logError(e, 'ADMIN', 'saveSettings.setupTriggers'); }
  }
  return { changed: changed.length, triggerMsg: triggerMsg };
}

/**
 * Removes demo/sample data. Rows referenced by real data are disabled /
 * soft-deleted instead of removed. Config is never touched.
 */
function clearSampleData(user) {
  var report = withLock(function () {
    var r = {};
    var sampleOrders = dbAll('ORDERS').filter(function (o) { return toBool(o.is_sample); });
    var orderIds = {};
    sampleOrders.forEach(function (o) { orderIds[o.order_id] = true; });
    r.orders = dbDeleteRows('ORDERS', sampleOrders.map(function (o) { return o._row; }));
    r.order_items = dbDeleteRows('ORDER_ITEMS', dbAll('ORDER_ITEMS').filter(function (i) { return toBool(i.is_sample) || orderIds[i.order_id]; }).map(function (i) { return i._row; }));
    r.payments = dbDeleteRows('PAYMENT', dbAll('PAYMENT').filter(function (x) { return toBool(x.is_sample) || orderIds[x.order_id]; }).map(function (x) { return x._row; }));

    var realOrders = dbAll('ORDERS');
    var usedWindows = {}, usedEmployees = {};
    realOrders.forEach(function (o) { usedWindows[o.window_id] = true; usedEmployees[o.employee_id] = true; });
    var usedItems = {};
    dbAll('ORDER_ITEMS').forEach(function (i) { usedItems[i.item_id] = true; });

    var sw = dbAll('MEAL_WINDOWS').filter(function (w) { return toBool(w.is_sample) && !usedWindows[w.window_id]; });
    var swIds = {};
    sw.forEach(function (w) { swIds[w.window_id] = true; });
    r.daily_menu = dbDeleteRows('DAILY_MENU', dbAll('DAILY_MENU').filter(function (d) { return swIds[d.window_id] || (toBool(d.is_sample) && !usedWindows[d.window_id]); }).map(function (d) { return d._row; }));
    r.windows = dbDeleteRows('MEAL_WINDOWS', sw.map(function (w) { return w._row; }));

    var menus = dbAll('MENU_ITEMS').filter(function (m) { return toBool(m.is_sample); });
    var usedDaily = {};
    dbAll('DAILY_MENU').forEach(function (d) { usedDaily[d.item_id] = true; });
    var softMenus = menus.filter(function (m) { return usedItems[m.item_id] || usedDaily[m.item_id]; });
    dbUpdateMany('MENU_ITEMS', softMenus.map(function (m) { return { row: m, changes: { is_deleted: 'TRUE', status: 'INACTIVE', is_sample: 'FALSE' } }; }));
    var hardMenus = dbAll('MENU_ITEMS').filter(function (m) { return toBool(m.is_sample); });
    r.menus_deleted = dbDeleteRows('MENU_ITEMS', hardMenus.map(function (m) { return m._row; }));
    r.menus_soft_deleted = softMenus.length;

    var emps = dbAll('EMPLOYEES').filter(function (e) { return toBool(e.is_sample) && e.employee_id !== user.employee_id; });
    var softEmps = emps.filter(function (e) { return usedEmployees[e.employee_id]; });
    dbUpdateMany('EMPLOYEES', softEmps.map(function (e) { return { row: e, changes: { status: 'DISABLED', is_sample: 'FALSE' } }; }));
    softEmps.forEach(function (e) { revokeAllSessions(e.employee_id); });
    var hardEmps = dbAll('EMPLOYEES').filter(function (e) { return toBool(e.is_sample) && e.employee_id !== user.employee_id; });
    hardEmps.forEach(function (e) { revokeAllSessions(e.employee_id); });
    r.employees_deleted = dbDeleteRows('EMPLOYEES', hardEmps.map(function (e) { return e._row; }));
    r.employees_disabled = softEmps.length;
    return r;
  });
  invalidateMenuCache();
  writeAudit(user, 'CLEAR_SAMPLE_DATA', 'SYSTEM', '', '', report);
  return report;
}

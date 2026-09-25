/**
 * Main.gs
 * ---------------------------------------------------------------------------
 * Web app entry points + one-time setup functions (run from the editor):
 *   setupDatabase()     create sheets / headers / default config (idempotent)
 *   setupFirstAdmin()   create the first ADMIN from Script Properties
 *   seedSampleData()    demo employees + menus (flagged is_sample)
 *   setupTriggers()     install time-driven triggers (TriggerService.gs)
 */

/**
 * Serves the single-page web app.
 * Optional ?page=kitchen|admin|pickup opens that section after login.
 */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('index');
  var page = String((e && e.parameter && e.parameter.page) || '').replace(/[^a-z]/g, '').substring(0, 20);
  t.initialPage = page;
  var company = 'โรงงาน ABC';
  try { company = cfg('COMPANY_NAME') || company; } catch (err) { /* DB not set up yet */ }
  t.companyName = company;
  return t.evaluate()
    .setTitle('ระบบจองอาหาร - ' + company)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setFaviconUrl('https://fonts.gstatic.com/s/e/notoemoji/latest/1f371/512.png')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * LINE webhook receiver (optional; used only to discover Group IDs).
 * Always answers 200 quickly as LINE requires.
 */
function doPost(e) {
  try { handleLineWebhook(e); } catch (err) { logError(err, 'LINE', 'doPost'); }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

/** HTML include helper used by templates: <?!= include('styles') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ------------------------------------------------------------------------- */
/* Setup                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Creates all sheets, headers and default config. NEVER deletes sheets/data:
 *  - missing sheets are created
 *  - missing header columns are appended at the end
 *  - missing config keys are added (existing values untouched)
 * Safe to run again after upgrades.
 */
function setupDatabase() {
  var ss = getDatabase();
  var report = [];
  Object.keys(SCHEMA).forEach(function (key) {
    var def = SCHEMA[key];
    var sh = ss.getSheetByName(def.name);
    if (!sh) {
      sh = ss.insertSheet(def.name);
      report.push('created ' + def.name);
    }
    var lastCol = sh.getLastColumn();
    var header = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
    var missing = def.columns.filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length) {
      var start = header.filter(String).length ? lastCol + 1 : 1;
      if (start === 1) header = [];
      if (sh.getMaxColumns() < start + missing.length - 1) {
        sh.insertColumnsAfter(sh.getMaxColumns(), start + missing.length - 1 - sh.getMaxColumns());
      }
      sh.getRange(1, start, 1, missing.length).setValues([missing]);
      header = header.concat(missing);
      report.push(def.name + ': +' + missing.join(','));
    }
    // Header style + freeze
    sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#17365D').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    // Column formats: '@' text for everything except numeric columns.
    var maxRows = Math.max(sh.getMaxRows(), 2);
    header.forEach(function (name, i) {
      if (!name) return;
      var fmt = def.numeric.indexOf(name) >= 0 ? (MONEY_COLUMNS[name] ? '#,##0.00' : '0') : '@';
      sh.getRange(2, i + 1, maxRows - 1, 1).setNumberFormat(fmt);
    });
  });
  DB_STATE.sheets = {};
  DB_STATE.headers = {};
  dbInvalidate();

  // Default config rows
  var existing = {};
  dbAll('CONFIG').forEach(function (r) { existing[r.key] = true; });
  var now = nowStr();
  var rows = DEFAULT_CONFIG.filter(function (r) { return !existing[r[0]]; }).map(function (r) {
    return { key: r[0], value: r[1], description: r[2], updated_at: now, updated_by: 'SETUP' };
  });
  dbInsertMany('CONFIG', rows);
  if (rows.length) report.push('config +' + rows.length);
  invalidateConfig();

  // Secrets (generated once, never overwritten)
  getAppSecret_();
  getPinPepper_();
  if (!getScriptProp(PROP.DATABASE_SHEET_ID)) setScriptProp(PROP.DATABASE_SHEET_ID, ss.getId());
  try { ss.setSpreadsheetTimeZone(APP.TIMEZONE); } catch (e) { /* ignore */ }

  systemLog('INFO', 'SETUP', 'SETUP_DATABASE', 'setupDatabase completed', report);
  Logger.log('setupDatabase done: ' + (report.length ? report.join(' | ') : 'no changes'));
  return report;
}

/**
 * Creates the first ADMIN. The PIN is NOT in source code - set Script Properties:
 *   INIT_ADMIN_ID   e.g. ADMIN01
 *   INIT_ADMIN_NAME e.g. ผู้ดูแลระบบ
 *   INIT_ADMIN_PIN  e.g. a 6-digit PIN (removed automatically after use)
 * If INIT_ADMIN_PIN is empty a random PIN is generated and printed to the log.
 * The admin must change the PIN on first login.
 */
function setupFirstAdmin() {
  var props = PropertiesService.getScriptProperties();
  var code = normalizeEmployeeCode(props.getProperty('INIT_ADMIN_ID') || 'ADMIN01');
  var name = sanitizeText(props.getProperty('INIT_ADMIN_NAME') || 'ผู้ดูแลระบบ', 100);
  var pinProp = props.getProperty('INIT_ADMIN_PIN') || '';
  var pin = pinProp ? validatePinFormat(pinProp) : generatePin();
  var result = withLock(function () {
    var existing = dbFindOne('EMPLOYEES', 'employee_code', code);
    if (existing) return { created: false, code: code };
    var now = nowStr();
    dbInsert('EMPLOYEES', {
      employee_id: uuid(), employee_code: code, name: name, department: 'Office', role: ROLE.ADMIN,
      pin_hash: hashPin(pin), status: 'ACTIVE', must_change_pin: 'TRUE', failed_attempts: 0, locked_until: '',
      created_at: now, updated_at: now, last_login: '', is_sample: 'FALSE'
    });
    return { created: true, code: code };
  });
  if (pinProp) props.deleteProperty('INIT_ADMIN_PIN');
  if (result.created) {
    writeAudit(null, 'CREATE_FIRST_ADMIN', 'SETUP', code, '', name);
    Logger.log('✅ First admin created: ' + code + (pinProp ? ' (PIN from INIT_ADMIN_PIN, property removed)' : ' | Generated PIN: ' + pin) +
      ' — PIN must be changed on first login.');
  } else {
    Logger.log('ℹ️ Employee ' + code + ' already exists. Nothing changed. Use resetAdminPin() if you are locked out.');
  }
  return result;
}

/**
 * Emergency: resets an admin's PIN from the editor. Uses INIT_ADMIN_ID and
 * INIT_ADMIN_PIN (or a generated PIN printed to the log).
 */
function resetAdminPin() {
  var props = PropertiesService.getScriptProperties();
  var code = normalizeEmployeeCode(props.getProperty('INIT_ADMIN_ID') || 'ADMIN01');
  var pinProp = props.getProperty('INIT_ADMIN_PIN') || '';
  var pin = pinProp ? validatePinFormat(pinProp) : generatePin();
  var emp = dbFindOne('EMPLOYEES', 'employee_code', code);
  assert(emp, 'NOT_FOUND', 'ไม่พบ ' + code);
  dbUpdate('EMPLOYEES', emp, { pin_hash: hashPin(pin), must_change_pin: 'TRUE', failed_attempts: 0, locked_until: '', status: 'ACTIVE', updated_at: nowStr() });
  revokeAllSessions(emp.employee_id);
  if (pinProp) props.deleteProperty('INIT_ADMIN_PIN');
  writeAudit(null, 'RESET_ADMIN_PIN', 'SETUP', code, '', 'editor');
  Logger.log('PIN reset for ' + code + (pinProp ? ' (from INIT_ADMIN_PIN)' : ': ' + pin));
}

/**
 * Seeds demo data (is_sample = TRUE). Idempotent: skips existing codes.
 * Demo PINs are generated randomly and printed to the execution log.
 * Remove later with Admin > Settings > "ล้างข้อมูลตัวอย่าง".
 */
function seedSampleData() {
  var employees = [
    ['EMP00125', 'สมชาย ใจดี', 'Production', ROLE.EMPLOYEE],
    ['EMP00126', 'สมหญิง รักงาน', 'QA', ROLE.EMPLOYEE],
    ['EMP00127', 'วิชัย ขยันยิ่ง', 'Warehouse', ROLE.EMPLOYEE],
    ['EMP00128', 'ประเสริฐ ช่างซ่อม', 'Maintenance', ROLE.EMPLOYEE],
    ['KIT001', 'ป้าแดง ครัวกลาง', 'Office', ROLE.KITCHEN],
    ['VIEW001', 'ผู้จัดการโรงงาน', 'Office', ROLE.VIEWER]
  ];
  var menus = [
    ['F001', 'กะเพราไก่ + ไข่ดาว', 'ผัดกะเพราไก่สับ ท็อปไข่ดาว', 'อาหารจานเดียว', 45, 50, 1],
    ['F002', 'ข้าวมันไก่', 'ข้าวมันไก่ต้ม น้ำจิ้มเต้าเจี้ยว', 'อาหารจานเดียว', 45, 40, 2],
    ['F003', 'ข้าวผัดหมู', 'ข้าวผัดหมู พร้อมแตงกวา มะนาว', 'อาหารจานเดียว', 40, 40, 3],
    ['F004', 'ราดหน้า', 'ราดหน้าหมูหมัก เส้นใหญ่', 'ก๋วยเตี๋ยว', 45, 30, 4]
  ];
  var created = [];
  withLock(function () {
    var now = nowStr();
    var existingEmp = {};
    dbAll('EMPLOYEES').forEach(function (e) { existingEmp[e.employee_code] = true; });
    var empRows = [];
    employees.forEach(function (e) {
      if (existingEmp[e[0]]) return;
      var pin = generatePin();
      created.push(e[0] + ' (' + e[3] + ') PIN: ' + pin);
      empRows.push({
        employee_id: uuid(), employee_code: e[0], name: e[1], department: e[2], role: e[3], pin_hash: hashPin(pin),
        status: 'ACTIVE', must_change_pin: 'FALSE', failed_attempts: 0, locked_until: '', created_at: now,
        updated_at: now, last_login: '', is_sample: 'TRUE'
      });
    });
    dbInsertMany('EMPLOYEES', empRows);
    var existingMenu = {};
    dbAll('MENU_ITEMS').forEach(function (m) { existingMenu[m.code] = true; });
    dbInsertMany('MENU_ITEMS', menus.filter(function (m) { return !existingMenu[m[0]]; }).map(function (m) {
      return {
        item_id: uuid(), code: m[0], name: m[1], description: m[2], category: m[3], default_price: m[4],
        default_stock: m[5], max_per_order: 0, image_url: '', status: 'ACTIVE', is_deleted: 'FALSE',
        sort_order: m[6], created_at: now, updated_at: now, is_sample: 'TRUE'
      };
    }));
  });
  invalidateMenuCache();
  // Make sure today's window picks up the new menus.
  try {
    ensureWindowsForDate(todayStr());
    withLock(function () {
      getWindowsByDate(todayStr()).forEach(function (w) {
        if (w.status !== WINDOW_STATUS.COMPLETED) copyMasterToDailyMenu_(w);
      });
    });
  } catch (e) { Logger.log('Window setup skipped: ' + e.message); }
  systemLog('INFO', 'SETUP', 'SEED_SAMPLE_DATA', 'Seeded sample data', { employees: created.length });
  Logger.log('Sample data seeded.\n' + (created.length ? created.join('\n') : 'Employees already exist (PINs unchanged).'));
  return created;
}

/**
 * One-click initial setup from the editor: database + first admin + triggers.
 */
function initialSetup() {
  setupDatabase();
  setupFirstAdmin();
  try { setupTriggers(); } catch (e) { Logger.log('setupTriggers failed: ' + e.message); }
  Logger.log('Initial setup finished. Deploy as Web App next (see DEPLOYMENT.md).');
}

/** Adds a helper menu when the script is bound to the database spreadsheet. */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('🍱 Food System')
      .addItem('1) Setup Database', 'setupDatabase')
      .addItem('2) Create First Admin', 'setupFirstAdmin')
      .addItem('3) Setup Triggers', 'setupTriggers')
      .addSeparator()
      .addItem('Seed Sample Data', 'seedSampleData')
      .addItem('Backup Now', 'runBackup')
      .addItem('Run Scheduler Now', 'runScheduler')
      .addToUi();
  } catch (e) { /* not bound / no UI */ }
}

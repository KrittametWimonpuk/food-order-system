/**
 * backend.test.js — executes the real Apps Script server code against the
 * in-memory GAS emulator and checks the business rules from TEST_CHECKLIST.md.
 *
 * Run:  node --test tests/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('./gas-mock');

function setup(config) {
  const env = createGasEnv({ quiet: true, props: { INIT_ADMIN_ID: 'ADMIN01', INIT_ADMIN_NAME: 'ผู้ดูแลระบบ', INIT_ADMIN_PIN: '482913' } });
  env.setNow('2026-09-25 07:00');
  env.ctx.setupDatabase();
  env.ctx.setupFirstAdmin();
  env.ctx.seedSampleData();
  if (config) env.setConfig(config);
  const pins = {};
  env.logs.join('\n').split('\n').forEach((l) => {
    const m = l.match(/^(\S+) \((\w+)\) PIN: (\d+)$/);
    if (m) pins[m[1]] = m[3];
  });
  return { env, pins };
}

function ok(res, msg) {
  assert.equal(res.success, true, (msg || '') + ' ' + JSON.stringify(res.error));
  assert.ok(res.requestId && res.requestId.startsWith('REQ-'));
  return res.data;
}
function err(res, code) {
  assert.equal(res.success, false, 'expected error ' + code + ' got success');
  assert.equal(res.error.code, code, 'expected ' + code + ' got ' + res.error.code + ': ' + res.error.message);
  return res.error;
}
function login(env, code, pin) {
  return ok(env.api('auth.login', { employeeCode: code, pin, remember: false }), 'login ' + code).token;
}
let tokSeq = 0;
function reqToken() { return 'req-' + Date.now() + '-' + (++tokSeq) + '-abcdefgh'; }

test('setupDatabase creates all 15 sheets with headers and is idempotent', () => {
  const { env } = setup();
  const names = env.db.getSheets().map((s) => s.getName());
  ['01_CONFIG', '02_EMPLOYEES', '03_USER_SESSIONS', '04_MEAL_WINDOWS', '05_MENU_ITEMS', '06_DAILY_MENU', '07_ORDERS',
    '08_ORDER_ITEMS', '09_ORDER_STATUS_LOG', '10_NOTIFICATION_QUEUE', '11_AUDIT_LOG', '12_PAYMENT', '13_DAILY_SUMMARY',
    '14_ERROR_LOG', '15_SYSTEM_LOG'].forEach((n) => assert.ok(names.includes(n), n));
  const empBefore = env.sheetRows('02_EMPLOYEES').length;
  const cfgBefore = env.sheetRows('01_CONFIG').length;
  env.newExecution();
  env.ctx.setupDatabase();
  assert.equal(env.sheetRows('02_EMPLOYEES').length, empBefore, 'employees preserved');
  assert.equal(env.sheetRows('01_CONFIG').length, cfgBefore, 'config not duplicated');
  assert.ok(env.props.APP_SECRET && env.props.PIN_SALT, 'secrets generated');
  assert.equal(env.props.INIT_ADMIN_PIN, undefined, 'INIT_ADMIN_PIN removed after use');
  // PIN is never stored in plain text
  const emp = env.sheetRows('02_EMPLOYEES');
  assert.ok(emp.every((r) => !r.includes('482913')));
});

test('setupDatabase appends new schema columns without touching data', () => {
  const { env } = setup();
  const sh = env.db.getSheetByName('07_ORDERS');
  const hdr = sh.data[0];
  const idx = hdr.indexOf('items_json');
  // simulate an old sheet without items_json: remove column header
  hdr[idx] = 'legacy_col';
  env.newExecution();
  env.ctx.setupDatabase();
  assert.ok(sh.data[0].includes('items_json'));
  assert.ok(sh.data[0].includes('legacy_col'));
});

test('login: success, wrong PIN, lockout, disabled employee, rate limit', () => {
  const { env, pins } = setup();
  const d = ok(env.api('auth.login', { employeeCode: 'emp00125', pin: pins.EMP00125 }));
  assert.equal(d.user.employee_code, 'EMP00125');
  assert.equal(d.user.pin_hash, undefined, 'no hash leaked');
  const e1 = err(env.api('auth.login', { employeeCode: 'EMP00126', pin: '000001' }), 'AUTH_INVALID');
  assert.match(e1.message, /เหลืออีก/);
  err(env.api('auth.login', { employeeCode: 'NOPE99', pin: '123456' }), 'AUTH_INVALID');
  // lockout after 5 attempts
  for (let i = 0; i < 3; i++) env.api('auth.login', { employeeCode: 'EMP00126', pin: '000001' });
  err(env.api('auth.login', { employeeCode: 'EMP00126', pin: '000001' }), 'AUTH_LOCKED');
  err(env.api('auth.login', { employeeCode: 'EMP00126', pin: pins.EMP00126 }), 'AUTH_LOCKED');
  env.setNow('2026-09-25 07:20');
  ok(env.api('auth.login', { employeeCode: 'EMP00126', pin: pins.EMP00126 }), 'unlocked after lock period');
  // disabled
  const admin = loginAdmin(env);
  const list = ok(env.api('emp.list', { q: 'EMP00127' }, admin));
  ok(env.api('emp.setStatus', { employee_id: list.rows[0].employee_id, status: 'DISABLED' }, admin));
  err(env.api('auth.login', { employeeCode: 'EMP00127', pin: pins.EMP00127 }), 'EMPLOYEE_DISABLED');
  // rate limit (10 failures / 10 min per code)
  for (let i = 0; i < 10; i++) env.api('auth.login', { employeeCode: 'GHOST1', pin: '123456' });
  err(env.api('auth.login', { employeeCode: 'GHOST1', pin: '123456' }), 'AUTH_RATE_LIMIT');
});

function loginAdmin(env) {
  const t = login(env, 'ADMIN01', env.__adminPin || '482913');
  const me = ok(env.api('auth.me', {}, t));
  if (me.user.must_change_pin) {
    err(env.api('employee.home', {}, t), 'PIN_CHANGE_REQUIRED');
    ok(env.api('auth.changePin', { currentPin: '482913', newPin: '731946' }, t));
    env.__adminPin = '731946';
  }
  return t;
}

test('first admin must change PIN; session expiry and logout', () => {
  const { env, pins } = setup();
  const t = loginAdmin(env);
  ok(env.api('admin.dashboard', {}, t));
  err(env.api('auth.login', { employeeCode: 'ADMIN01', pin: '482913' }), 'AUTH_INVALID');
  // session timeout (120 min idle)
  const t2 = login(env, 'EMP00125', pins.EMP00125);
  env.setNow('2026-09-25 09:30');
  err(env.api('employee.home', {}, t2), 'SESSION_EXPIRED');
  // logout revokes
  const t3 = login(env, 'EMP00125', pins.EMP00125);
  ok(env.api('auth.logout', {}, t3));
  err(env.api('auth.me', {}, t3), 'SESSION_EXPIRED');
  err(env.api('auth.me', {}, 'garbage'), 'SESSION_EXPIRED');
});

test('ordering rules: before open, normal, multi-item, double submit, existing order, cutoff', () => {
  // Strict mode: one order per meal, max 3 boxes (the defaults are now unlimited).
  const { env, pins } = setup({ ALLOW_MULTIPLE_ORDERS: 'FALSE', MAX_QTY_PER_ORDER: '3' });
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  assert.equal(home.window.meal, 'LUNCH');
  assert.equal(home.window.status, 'DRAFT');
  assert.equal(home.menu.length, 4);
  const kapao = home.menu.find((m) => m.name.startsWith('กะเพรา'));
  const chicken = home.menu.find((m) => m.name === 'ข้าวมันไก่');
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 1 }], request_token: reqToken() }, t), 'MEAL_NOT_OPEN');

  env.setNow('2026-09-25 08:05');
  const t1 = login(env, 'EMP00125', pins.EMP00125);
  const token = reqToken();
  const payload = { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 1, note: 'ไม่เผ็ด' }, { daily_menu_id: chicken.daily_menu_id, qty: 1 }], note: '', request_token: token, expected_total: 90 };
  const o = ok(env.api('order.create', payload, t1)).order;
  assert.match(o.order_no, /^ORD-260925-0001$/);
  assert.equal(o.total_qty, 2);
  assert.equal(o.total_amount, 90);
  assert.equal(o.status, 'CONFIRMED');
  assert.equal(o.items[0].note, 'ไม่เผ็ด');
  // Double click / retry with the same token -> same order, no new rows
  const again = ok(env.api('order.create', payload, t1));
  assert.equal(again.duplicate, true);
  assert.equal(again.order.order_id, o.order_id);
  assert.equal(env.sheetRows('07_ORDERS').length, 1);
  // Existing order in this meal
  err(env.api('order.create', Object.assign({}, payload, { request_token: reqToken() }), t1), 'ORDER_EXISTS');
  // Stock counters updated
  const home2 = ok(env.api('employee.home', {}, t1));
  assert.equal(home2.menu.find((m) => m.daily_menu_id === kapao.daily_menu_id).sold_qty, 1);
  // Price verification
  const t2 = login(env, 'EMP00126', pins.EMP00126);
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 1 }], request_token: reqToken(), expected_total: 10 }, t2), 'PRICE_CHANGED');
  // Max qty per order (3)
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 4 }], request_token: reqToken() }, t2), 'INVALID_QTY');
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 0 }], request_token: reqToken() }, t2), 'INVALID_QTY');
  // Client can't inject price / employee id
  const o2 = ok(env.api('order.create', { window_id: home.window.window_id, employee_id: 'HACK', items: [{ daily_menu_id: kapao.daily_menu_id, qty: 1, unit_price: 1 }], request_token: reqToken() }, t2)).order;
  assert.equal(o2.total_amount, 45);
  assert.equal(o2.employee_code, 'EMP00126');
  assert.equal(o2.order_no, 'ORD-260925-0002');
  // After cutoff
  env.setNow('2026-09-25 10:30');
  const t3 = login(env, 'EMP00127', pins.EMP00127);
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: kapao.daily_menu_id, qty: 1 }], request_token: reqToken() }, t3), 'MEAL_CLOSED');
});

test('stock: sold out and two employees racing for the last box', () => {
  const { env, pins } = setup();
  const admin = loginAdmin(env);
  const meals = ok(env.api('meal.list', {}, admin));
  const w = meals.rows.find((r) => r.date === '2026-09-25' && r.meal === 'LUNCH');
  const dm = ok(env.api('daily.list', { window_id: w.window_id }, admin)).rows.find((r) => r.name === 'ราดหน้า');
  ok(env.api('daily.save', { daily_menu_id: dm.daily_menu_id, stock_limit: 1 }, admin));
  env.setNow('2026-09-25 09:00');
  const a = login(env, 'EMP00125', pins.EMP00125);
  const b = login(env, 'EMP00126', pins.EMP00126);
  const admin2 = loginAdmin(env);
  const r1 = env.api('order.create', { window_id: w.window_id, items: [{ daily_menu_id: dm.daily_menu_id, qty: 1 }], request_token: reqToken() }, a);
  const r2 = env.api('order.create', { window_id: w.window_id, items: [{ daily_menu_id: dm.daily_menu_id, qty: 1 }], request_token: reqToken() }, b);
  ok(r1);
  err(r2, 'MENU_SOLD_OUT');
  const after = ok(env.api('daily.list', { window_id: w.window_id }, admin2)).rows.find((r) => r.name === 'ราดหน้า');
  assert.equal(after.sold_qty, 1);
  assert.equal(after.remaining, 0);
  assert.equal(after.status, 'SOLD_OUT');
  // Stock limit can't go below sold
  err(env.api('daily.save', { daily_menu_id: dm.daily_menu_id, stock_limit: 0 }, admin2), 'VALIDATION_ERROR');
  // Every order creation goes through the lock
  assert.ok(env.lockState.count > 0);
  // Lock timeout returns a friendly error, order not created
  env.lockState.failNext = true;
  err(env.api('order.create', { window_id: w.window_id, items: [{ daily_menu_id: dm.daily_menu_id, qty: 1 }], request_token: reqToken() }, b), 'LOCK_TIMEOUT');
});

test('edit and cancel order adjust stock; payment voided', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  const [m1, m2] = home.menu;
  const o = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: m1.daily_menu_id, qty: 2 }], request_token: reqToken() }, t)).order;
  assert.equal(o.can_edit, true);
  const edited = ok(env.api('order.update', { order_id: o.order_id, items: [{ daily_menu_id: m2.daily_menu_id, qty: 1 }], note: 'แก้ไข' }, t)).order;
  assert.equal(edited.total_qty, 1);
  assert.equal(edited.items[0].daily_menu_id, m2.daily_menu_id);
  let menu = ok(env.api('employee.home', {}, t)).menu;
  assert.equal(menu.find((m) => m.daily_menu_id === m1.daily_menu_id).sold_qty, 0);
  assert.equal(menu.find((m) => m.daily_menu_id === m2.daily_menu_id).sold_qty, 1);
  // other user can't touch it
  const t2 = login(env, 'EMP00126', pins.EMP00126);
  err(env.api('order.cancel', { order_id: o.order_id }, t2), 'ACCESS_DENIED');
  const c = ok(env.api('order.cancel', { order_id: o.order_id }, t)).order;
  assert.equal(c.status, 'CANCELLED');
  err(env.api('order.cancel', { order_id: o.order_id }, t), 'ORDER_ALREADY_CANCELLED');
  menu = ok(env.api('employee.home', {}, t)).menu;
  assert.equal(menu.find((m) => m.daily_menu_id === m2.daily_menu_id).sold_qty, 0);
  const pay = env.sheetRows('12_PAYMENT');
  const hdr = env.sheetHeader('12_PAYMENT');
  assert.equal(pay[0][hdr.indexOf('status')], 'VOID');
  // Can re-order after cancelling
  ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: m1.daily_menu_id, qty: 1 }], request_token: reqToken() }, t));
  // Edit after cutoff blocked
  const mine = ok(env.api('order.mine', { tab: 'today' }, t)).rows.find((r) => r.status === 'CONFIRMED');
  env.setNow('2026-09-25 10:31');
  const t3 = login(env, 'EMP00125', pins.EMP00125);
  err(env.api('order.update', { order_id: mine.order_id, items: [{ daily_menu_id: m1.daily_menu_id, qty: 2 }] }, t3), 'MEAL_CLOSED');
  err(env.api('order.cancel', { order_id: mine.order_id }, t3), 'MEAL_CLOSED');
});

test('kitchen: RBAC, status transitions, pickup and double pickup', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const e = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, e));
  const o = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], request_token: reqToken() }, e)).order;
  err(env.api('kitchen.dashboard', {}, e), 'ACCESS_DENIED');
  err(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'PICKED_UP' }, e), 'ACCESS_DENIED');
  const k = login(env, 'KIT001', pins.KIT001);
  const dash = ok(env.api('kitchen.dashboard', {}, k));
  assert.equal(dash.kpi.orders, 1);
  assert.equal(dash.kpi.qty, 1);
  assert.equal(dash.byMenu[0].qty, 1);
  const list = ok(env.api('kitchen.orders', { status: 'CONFIRMED', q: 'สมชาย' }, k));
  assert.equal(list.total, 1);
  assert.equal(ok(env.api('kitchen.orders', { q: 'nobody' }, k)).total, 0);
  ok(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'PREPARING' }, k));
  err(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'CONFIRMED' }, k), 'INVALID_STATUS');
  // employee can no longer cancel once preparing
  err(env.api('order.cancel', { order_id: o.order_id }, e), 'INVALID_STATUS');
  ok(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'READY' }, k));
  const found = ok(env.api('kitchen.lookup', { q: 'emp00125' }, k));
  assert.equal(found.rows.length, 1);
  const byNo = ok(env.api('kitchen.lookup', { q: o.order_no }, k));
  assert.equal(byNo.rows[0].order_id, o.order_id);
  const p = ok(env.api('kitchen.pickup', { order_id: o.order_id }, k)).order;
  assert.equal(p.status, 'PICKED_UP');
  assert.equal(p.picked_up_by, 'KIT001');
  assert.ok(p.picked_up_at);
  err(env.api('kitchen.pickup', { order_id: o.order_id }, k), 'ORDER_ALREADY_PICKED_UP');
  err(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'READY' }, k), 'ORDER_ALREADY_PICKED_UP');
  // admin may revert a mistaken pickup
  const a = loginAdmin(env);
  ok(env.api('kitchen.setStatus', { order_id: o.order_id, status: 'READY', reason: 'กดผิด' }, a));
  const logRows = env.sheetRows('09_ORDER_STATUS_LOG');
  assert.ok(logRows.length >= 5);
  // viewer: dashboard + report only
  const v = login(env, 'VIEW001', pins.VIEW001);
  ok(env.api('admin.dashboard', {}, v));
  ok(env.api('report.get', {}, v));
  err(env.api('menu.save', { name: 'x', default_price: 1, default_stock: 1 }, v), 'ACCESS_DENIED');
  err(env.api('kitchen.pickup', { order_id: o.order_id }, v), 'ACCESS_DENIED');
  err(env.api('emp.list', {}, v), 'ACCESS_DENIED');
  err(env.api('nope.action', {}, v), 'UNKNOWN_ACTION');
});

test('admin: add menu, add employee (generated PIN), import CSV, settings, audit log', () => {
  const { env } = setup();
  const a = loginAdmin(env);
  const item = ok(env.api('menu.save', { name: 'ผัดซีอิ๊ว', default_price: 40, default_stock: 20, category: 'อาหารจานเดียว', image_url: 'https://example.com/a.jpg' }, a)).item;
  assert.equal(item.code, 'F005');
  err(env.api('menu.save', { name: 'x', default_price: -1, default_stock: 1 }, a), 'VALIDATION_ERROR');
  err(env.api('menu.save', { name: 'xx', default_price: 1, default_stock: 1, image_url: 'javascript:alert(1)' }, a), 'VALIDATION_ERROR');
  ok(env.api('menu.save', { item_id: item.item_id, name: 'ผัดซีอิ๊ว', default_price: 50, default_stock: 20 }, a));
  ok(env.api('menu.toggle', { item_id: item.item_id, status: 'INACTIVE' }, a));
  ok(env.api('menu.delete', { item_id: item.item_id }, a));
  assert.equal(ok(env.api('menu.list', {}, a)).rows.some((m) => m.item_id === item.item_id), false);
  assert.equal(ok(env.api('menu.list', { includeDeleted: true }, a)).rows.some((m) => m.item_id === item.item_id), true);

  const emp = ok(env.api('emp.save', { employee_code: 'EMP00999', name: 'ทดสอบ ระบบ', department: 'QA', role: 'EMPLOYEE' }, a));
  assert.match(emp.generatedPin, /^\d{6}$/);
  err(env.api('emp.save', { employee_code: 'EMP00999', name: 'ซ้ำ', department: 'QA', role: 'EMPLOYEE' }, a), 'DUPLICATE_CODE');
  const t = login(env, 'EMP00999', emp.generatedPin);
  err(env.api('employee.home', {}, t), 'PIN_CHANGE_REQUIRED');
  const reset = ok(env.api('emp.resetPin', { employee_id: emp.employee.employee_id }, a));
  err(env.api('auth.me', {}, t), 'SESSION_EXPIRED');
  login(env, 'EMP00999', reset.generatedPin);

  const imp = ok(env.api('emp.import', { csv: 'employee_code,name,department,role,pin\nEMP01000,นำเข้า หนึ่ง,Production,EMPLOYEE,\nEMP00999,ซ้ำ,QA,EMPLOYEE,\nbad code!,x,QA,EMPLOYEE,' }, a));
  assert.equal(imp.created.length, 1);
  assert.equal(imp.skipped.length, 1);
  assert.equal(imp.errors.length, 1);

  // Cannot disable yourself / last admin
  const me = ok(env.api('auth.me', {}, a)).user;
  err(env.api('emp.setStatus', { employee_id: me.employee_id, status: 'DISABLED' }, a), 'VALIDATION_ERROR');
  err(env.api('emp.save', { employee_id: me.employee_id, name: 'Admin', department: 'Office', role: 'EMPLOYEE' }, a), 'VALIDATION_ERROR');

  ok(env.api('settings.save', { values: { MAX_QTY_PER_ORDER: '5', LUNCH_CLOSE_TIME: '10:45' } }, a));
  const s = ok(env.api('settings.get', {}, a));
  assert.equal(s.items.find((i) => i.key === 'MAX_QTY_PER_ORDER').value, '5');
  err(env.api('settings.save', { values: { LUNCH_CLOSE_TIME: '25:99' } }, a), 'VALIDATION_ERROR');
  err(env.api('settings.save', { values: { APP_SECRET: 'x' } }, a), 'VALIDATION_ERROR');

  const audit = ok(env.api('log.audit', { q: 'UPDATE_MENU' }, a));
  assert.ok(audit.rows.length >= 1);
  const upd = audit.rows[0];
  assert.match(upd.old_value, /"default_price":40/);
  assert.match(upd.new_value, /50/);
});

test('scheduler: auto open/close, final LINE summary, retry then FAILED, manual retry, NO_SHOW', () => {
  const { env, pins } = setup();
  env.props.LINE_CHANNEL_ACCESS_TOKEN = 'test-token-1234567890';
  env.props.LINE_TARGET_ID = 'Cgroup1234567890';
  env.setNow('2026-09-25 08:01');
  env.newExecution();
  env.ctx.runScheduler();
  const hdr = env.sheetHeader('04_MEAL_WINDOWS');
  assert.equal(env.sheetRows('04_MEAL_WINDOWS')[0][hdr.indexOf('status')], 'OPEN');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 2 }], request_token: reqToken() }, t));
  // periodic summary at 08:30
  env.setNow('2026-09-25 08:30');
  env.newExecution();
  env.ctx.runScheduler();
  assert.equal(env.fetchLog.length, 1, 'summary sent');
  assert.match(env.fetchLog[0].body.messages[0].text, /🍱 สรุปยอดอาหาร/);
  assert.match(env.fetchLog[0].body.messages[0].text, /กะเพราไก่ \+ ไข่ดาว 2/);
  assert.equal(env.fetchLog[0].opts.headers.Authorization, 'Bearer test-token-1234567890');
  // LINE down at cutoff: order system unaffected, message retried then FAILED
  env.fetchBehaviour.mode = 'fail';
  env.setNow('2026-09-25 10:31');
  env.newExecution();
  env.ctx.runScheduler();
  assert.equal(env.sheetRows('04_MEAL_WINDOWS')[0][hdr.indexOf('status')], 'CLOSED');
  const qh = env.sheetHeader('10_NOTIFICATION_QUEUE');
  const finalRow = () => env.sheetRows('10_NOTIFICATION_QUEUE').find((r) => r[qh.indexOf('type')] === 'FINAL_SUMMARY');
  assert.equal(finalRow()[qh.indexOf('status')], 'RETRY');
  assert.match(JSON.parse(finalRow()[qh.indexOf('payload')]).text, /🔴 ปิดรับ Order แล้ว[\s\S]*รวม 1 Order[\s\S]*2 กล่อง[\s\S]*Kitchen Dashboard/);
  env.setNow('2026-09-25 10:40'); env.newExecution(); env.ctx.runScheduler();
  env.setNow('2026-09-25 10:50'); env.newExecution(); env.ctx.runScheduler();
  assert.equal(finalRow()[qh.indexOf('status')], 'FAILED');
  assert.equal(Number(finalRow()[qh.indexOf('retry_count')]), 3);
  // Final summary is queued only once
  assert.equal(env.sheetRows('10_NOTIFICATION_QUEUE').filter((r) => r[qh.indexOf('type')] === 'FINAL_SUMMARY').length, 1);
  // Manual retry by admin once LINE is back
  env.fetchBehaviour.mode = 'ok';
  const a = loginAdmin(env);
  const failed = ok(env.api('noti.list', { status: 'FAILED' }, a)).rows[0];
  const rr = ok(env.api('noti.retry', { notification_id: failed.notification_id }, a));
  assert.equal(rr.result.sent, 1);
  assert.equal(finalRow()[qh.indexOf('status')], 'SENT');
  // test LINE button
  ok(env.api('line.test', {}, a));
  assert.match(env.fetchLog[env.fetchLog.length - 1].body.messages[0].text, /LINE Messaging API เชื่อมต่อสำเร็จ/);
  const st = ok(env.api('line.status', {}, a));
  assert.equal(st.connected, true);
  assert.ok(!JSON.stringify(st).includes('test-token-1234567890'), 'token never returned in full');
  // pickup window -> completed -> NO_SHOW
  env.setNow('2026-09-25 13:01'); env.newExecution(); env.ctx.runScheduler();
  assert.equal(env.sheetRows('04_MEAL_WINDOWS')[0][hdr.indexOf('status')], 'COMPLETED');
  const oh = env.sheetHeader('07_ORDERS');
  assert.equal(env.sheetRows('07_ORDERS')[0][oh.indexOf('status')], 'NO_SHOW');
  const sh = env.sheetHeader('13_DAILY_SUMMARY');
  const sum = env.sheetRows('13_DAILY_SUMMARY')[0];
  assert.equal(Number(sum[sh.indexOf('no_show')]), 1);
  assert.equal(Number(sum[sh.indexOf('total_qty')]), 2);
});

test('LINE failure never blocks order creation (INSTANT mode)', () => {
  const { env, pins } = setup();
  const a = loginAdmin(env);
  ok(env.api('settings.save', { values: { LINE_NOTIFICATION_MODE: 'INSTANT' } }, a));
  env.props.LINE_CHANNEL_ACCESS_TOKEN = 'tok-abcdefghijk';
  env.props.LINE_TARGET_ID = 'Cabc1234567';
  env.fetchBehaviour.mode = 'error';
  env.setNow('2026-09-25 08:30');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  const o = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], request_token: reqToken() }, t));
  assert.equal(o.order.status, 'CONFIRMED');
  const qh = env.sheetHeader('10_NOTIFICATION_QUEUE');
  const row = env.sheetRows('10_NOTIFICATION_QUEUE').find((r) => r[qh.indexOf('type')] === 'ORDER_INSTANT');
  assert.ok(row, 'instant notification queued');
});

test('reports, CSV export, backup, triggers, sample data cleanup', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }, { daily_menu_id: home.menu[1].daily_menu_id, qty: 2 }], request_token: reqToken() }, t));
  const a = loginAdmin(env);
  const rep = ok(env.api('report.get', { from: '2026-09-01', to: '2026-09-30' }, a));
  assert.equal(rep.kpi.orders, 1);
  assert.equal(rep.kpi.qty, 3);
  assert.equal(rep.kpi.revenue, 135);
  assert.equal(rep.byDate.length, 30);
  assert.equal(rep.byDepartment[0].department, 'Production');
  const csv = ok(env.api('report.export', { type: 'orders', from: '2026-09-25', to: '2026-09-25' }, a));
  assert.ok(csv.csv.startsWith('﻿'));
  assert.match(csv.csv, /ORD-260925-0001/);
  assert.match(csv.csv, /สมชาย ใจดี/);
  ['menu', 'department', 'employee', 'daily'].forEach((type) => ok(env.api('report.export', { type }, a)));
  const b1 = ok(env.api('backup.run', {}, a));
  assert.match(b1.path, /^FoodFactory-Backup\/2026\/09\/$/);
  env.setNow('2026-09-25 08:31');
  const b2 = ok(env.api('backup.run', {}, a));
  assert.notEqual(b1.name, b2.name, 'backups never overwrite');
  assert.equal(ok(env.api('backup.list', {}, a)).rows.length, 2);
  const tr = ok(env.api('trigger.install', {}, a));
  assert.equal(tr.missing.length, 0);
  assert.equal(env.triggers().length, 3);
  // Clearing samples keeps config and real data; employees with orders are disabled, not deleted
  const cfgCount = env.sheetRows('01_CONFIG').length;
  const res = ok(env.api('sample.clear', {}, a));
  assert.equal(env.sheetRows('01_CONFIG').length, cfgCount);
  assert.ok(res.employees_disabled >= 1);
  assert.equal(env.sheetRows('07_ORDERS').length, 1, 'real orders preserved');
  const ad = ok(env.api('admin.dashboard', {}, a));
  assert.equal(ad.kpi.orders, 1);
});

test('unexpected errors go to ERROR_LOG with a generic message', () => {
  const { env } = setup();
  const a = loginAdmin(env);
  env.ctx.getLineStatus = function () { throw new Error('boom'); };
  env.ctx.ROUTES_CACHE = null;
  const r = env.api('line.status', {}, a);
  err(r, 'INTERNAL_ERROR');
  assert.equal(r.error.message.includes('boom'), false);
  const logs = ok(env.api('log.error', {}, a));
  assert.ok(logs.rows.some((x) => x.error_message === 'boom' && x.request_id === r.requestId));
});

test('input sanitisation: formula injection and payload validation', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  const o = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], note: '=HYPERLINK("http://x")<script>', request_token: reqToken() }, t)).order;
  assert.equal(o.note.includes('<'), false);
  err(env.api('order.create', 'not json', t), 'VALIDATION_ERROR');
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: 'x', qty: 1 }], request_token: reqToken() }, t), 'MENU_NOT_FOUND');
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], request_token: 'short' }, t), 'VALIDATION_ERROR');
  const a = loginAdmin(env);
  const csv = ok(env.api('report.export', { type: 'orders' }, a)).csv;
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)script"/);
});

test('defaults: multiple orders per meal and unlimited boxes per order', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', {}, t));
  assert.equal(home.app.allowMultipleOrders, true);
  assert.equal(home.app.maxQtyPerOrder, 0);
  const [m1, m2, m3] = home.menu;
  const o1 = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: m1.daily_menu_id, qty: 5 }, { daily_menu_id: m2.daily_menu_id, qty: 4 }], request_token: reqToken() }, t)).order;
  assert.equal(o1.total_qty, 9);
  const o2 = ok(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: m3.daily_menu_id, qty: 2 }], request_token: reqToken() }, t)).order;
  assert.notEqual(o1.order_id, o2.order_id);
  assert.equal(ok(env.api('order.mine', { tab: 'today' }, t)).rows.length, 2);
  // stock is still enforced
  err(env.api('order.create', { window_id: home.window.window_id, items: [{ daily_menu_id: m1.daily_menu_id, qty: 99 }], request_token: reqToken() }, t), 'MENU_SOLD_OUT');
  // 0 is accepted in settings, >100 is not
  const a = loginAdmin(env);
  ok(env.api('settings.save', { values: { MAX_QTY_PER_ORDER: '0' } }, a));
  err(env.api('settings.save', { values: { MAX_QTY_PER_ORDER: '101' } }, a), 'VALIDATION_ERROR');
});

test('meal windows: edit a completed window re-opens it; soft delete + recreate', () => {
  const { env, pins } = setup();
  const a = loginAdmin(env);
  const w0 = ok(env.api('meal.list', {}, a)).rows.find((r) => r.date === '2026-09-25' && r.meal === 'LUNCH');
  // Create a dinner by mistake, end it manually
  const dinner = ok(env.api('meal.save', { date: '2026-09-25', meal: 'DINNER', open: '06:00', close: '06:30', pickup_start: '06:40', pickup_end: '06:50', auto: true }, a)).window;
  env.setNow('2026-09-25 07:10');
  const a2 = loginAdmin(env);
  ok(env.api('meal.setStatus', { window_id: dinner.window_id, status: 'COMPLETED' }, a2));
  // Edit its times into the future -> status recomputed, orderable again once open
  const ed = ok(env.api('meal.save', { window_id: dinner.window_id, date: '2026-09-25', meal: 'DINNER', open: '07:00', close: '15:30', pickup_start: '17:00', pickup_end: '19:00', auto: true }, a2)).window;
  assert.equal(ed.status, 'OPEN');
  assert.equal(ed.can_order, true);
  // Delete: allowed with no orders; hidden from lists; not auto-recreated; can be recreated manually
  ok(env.api('meal.delete', { window_id: w0.window_id }, a2));
  env.newExecution();
  env.ctx.runScheduler();
  const rows = ok(env.api('meal.list', {}, a2)).rows.filter((r) => r.date === '2026-09-25');
  assert.equal(rows.some((r) => r.meal === 'LUNCH'), false, 'deleted lunch not shown and not recreated');
  const again = ok(env.api('meal.save', { date: '2026-09-25', meal: 'LUNCH', open: '07:00', close: '10:30', pickup_start: '11:30', pickup_end: '13:00', auto: true }, a2)).window;
  assert.notEqual(again.window_id, w0.window_id);
  err(env.api('meal.delete', { window_id: w0.window_id }, a2), 'MEAL_NOT_FOUND');
  // Delete is refused while active orders exist, allowed after they are cancelled
  const t = login(env, 'EMP00125', pins.EMP00125);
  const home = ok(env.api('employee.home', { window_id: again.window_id }, t));
  const o = ok(env.api('order.create', { window_id: again.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], request_token: reqToken() }, t)).order;
  err(env.api('meal.delete', { window_id: again.window_id }, a2), 'VALIDATION_ERROR');
  ok(env.api('order.cancel', { order_id: o.order_id }, t));
  ok(env.api('meal.delete', { window_id: again.window_id }, a2));
  err(env.api('order.create', { window_id: again.window_id, items: [{ daily_menu_id: home.menu[0].daily_menu_id, qty: 1 }], request_token: reqToken() }, t), 'MEAL_NOT_FOUND');
  // Only admins can delete
  err(env.api('meal.delete', { window_id: dinner.window_id }, t), 'ACCESS_DENIED');
  // Soft delete: row still in the sheet
  const hdr = env.sheetHeader('04_MEAL_WINDOWS');
  assert.ok(env.sheetRows('04_MEAL_WINDOWS').some((r) => r[hdr.indexOf('window_id')] === w0.window_id && r[hdr.indexOf('status')] === 'DELETED'));
});

test('menu master changes reach upcoming meals; scheduler fills missing menus', () => {
  const { env, pins } = setup();
  env.setNow('2026-09-25 08:30');
  const a = loginAdmin(env);
  const t = login(env, 'EMP00125', pins.EMP00125);
  const names = () => ok(env.api('employee.home', {}, t)).menu.map((m) => m.name);
  assert.equal(names().length, 4);
  // New menu appears for employees immediately
  const r = ok(env.api('menu.save', { name: 'ข้าวกะเพราหมึก', default_price: 55, default_stock: 50, status: 'ACTIVE' }, a));
  assert.equal(r.sync.added, 1);
  assert.ok(names().includes('ข้าวกะเพราหมึก'));
  // Turning it off hides it; turning it on brings it back
  ok(env.api('menu.toggle', { item_id: r.item.item_id, status: 'INACTIVE' }, a));
  assert.ok(!names().includes('ข้าวกะเพราหมึก'));
  ok(env.api('menu.toggle', { item_id: r.item.item_id, status: 'ACTIVE' }, a));
  assert.ok(names().includes('ข้าวกะเพราหมึก'));
  // Master price edit follows to today's (uncustomised) daily menu; customised price is kept
  ok(env.api('menu.save', { item_id: r.item.item_id, name: 'ข้าวกะเพราหมึก', default_price: 60, default_stock: 50, status: 'ACTIVE' }, a));
  assert.equal(ok(env.api('employee.home', {}, t)).menu.find((m) => m.name === 'ข้าวกะเพราหมึก').price, 60);
  // Delete hides it
  ok(env.api('menu.delete', { item_id: r.item.item_id }, a));
  assert.ok(!names().includes('ข้าวกะเพราหมึก'));
  // Legacy data: a menu that is ACTIVE but missing from today's meal gets added by the scheduler
  const mh = env.sheetHeader('05_MENU_ITEMS');
  env.db.getSheetByName('05_MENU_ITEMS').data.push(mh.map((c) => ({ item_id: '11111111-1111-4111-8111-111111111111', code: 'F099', name: 'สุกี้หมู', default_price: 50, default_stock: 50, max_per_order: 0, status: 'ACTIVE', is_deleted: 'FALSE', sort_order: 9 }[c] ?? '')));
  env.cache && delete env.cache.menu_master_v1;
  assert.ok(!names().includes('สุกี้หมู'));
  env.newExecution();
  const rep = env.ctx.runScheduler();
  assert.equal(rep.fillDailyMenus, 1);
  assert.ok(names().includes('สุกี้หมู'));
  // A menu the admin removed from the day is NOT re-added by the scheduler
  const w = ok(env.api('meal.list', {}, a)).rows.find((x) => x.date === '2026-09-25');
  const dm = ok(env.api('daily.list', { window_id: w.window_id }, a)).rows.find((x) => x.name === 'สุกี้หมู');
  ok(env.api('daily.remove', { daily_menu_id: dm.daily_menu_id }, a));
  env.newExecution();
  assert.equal(env.ctx.runScheduler().fillDailyMenus, 0);
  assert.ok(!names().includes('สุกี้หมู'));
});

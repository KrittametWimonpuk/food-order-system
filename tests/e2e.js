/**
 * e2e.js — end-to-end UI test with Playwright against the emulated backend.
 *   node tests/e2e.js            (screenshots -> tests/output/)
 * Requires Playwright (npm i -D playwright, or a global install).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const { startServer } = require('./dev-server');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const globalPath = path.join(process.execPath, '..', '..', 'lib', 'node_modules', 'playwright');
  return require(globalPath);
}
const { chromium } = loadPlaywright();
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (detail && !cond ? ' — ' + detail : ''));
}

async function newPage(browser, viewport, errors, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'th-TH' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|fonts\.g|cdnjs/.test(m.text())) errors.push(label + ' console: ' + m.text());
  });
  return page;
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); }
async function noHScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function login(page, url, code, pin) {
  await page.goto(url);
  await page.waitForSelector('#empCode');
  await page.fill('#empCode', code);
  await page.fill('#empPin', pin);
  await page.click('#loginBtn');
}

(async () => {
  // E2E exercises the strict limits (1 order per meal, max 3 boxes) to cover those UI rules.
  const { server, pins, port, env } = await startServer({ now: '2026-09-25 09:00', config: { ALLOW_MULTIPLE_ORDERS: 'FALSE', MAX_QTY_PER_ORDER: '3' } });
  const url = 'http://localhost:' + port + '/';
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  const errors = [];
  try {
    /* ---------------- Employee (mobile) ---------------- */
    console.log('Employee mobile flow');
    const m = await newPage(browser, { width: 390, height: 844 }, errors, 'employee');
    await m.goto(url);
    await m.waitForSelector('#empCode');
    await shot(m, '01-login');
    await m.fill('#empCode', 'EMP00125');
    await m.fill('#empPin', '000000');
    await m.click('#loginBtn');
    await m.waitForSelector('.login-alert');
    check('wrong PIN shows error', (await m.textContent('.login-alert')).includes('ไม่ถูกต้อง'));
    await m.click('#togglePin');
    check('show/hide PIN toggles', (await m.getAttribute('#empPin', 'type')) === 'text');
    await m.fill('#empPin', pins.EMP00125);
    await m.click('#loginBtn');
    await m.waitForSelector('.meal-card');
    await m.waitForTimeout(1200);
    check('home shows employee name', (await m.textContent('.m-hello .name')).includes('สมชาย ใจดี'));
    const t1 = await m.textContent('.countdown .timer');
    await m.waitForTimeout(1100);
    const t2 = await m.textContent('.countdown .timer');
    check('countdown ticks', t1 !== t2 && /\d\d:\d\d:\d\d/.test(t2), t1 + ' -> ' + t2);
    await shot(m, '02-employee-home');
    check('home no horizontal scroll', await noHScroll(m));

    await m.click('.mobile-nav button[data-view="order"]');
    await m.waitForSelector('.menu-list .menu-card');
    await shot(m, '03-menu');
    // Menu detail
    await m.click('.menu-list [data-pick]');
    await m.waitForSelector('#dQty');
    await m.click('#dInc');
    await m.click('.note-chip[data-chip="ไม่เผ็ด"]');
    await shot(m, '03b-menu-detail');
    await m.click('.modal-footer .btn-primary');
    await m.waitForSelector('#cartBar');
    // second item via stepper
    const picks = await m.$$('.menu-list [data-pick]');
    await picks[0].click();
    await m.waitForSelector('#dQty');
    await m.click('.modal-footer .btn-primary');
    await m.waitForTimeout(200);
    check('cart shows 3 boxes', (await m.textContent('#cbCount')).trim() === '3');
    // exceed max (3) via stepper
    await m.click('[data-inc]');
    await m.waitForSelector('.toast-warning');
    check('max qty per order enforced in UI', (await m.textContent('.toast-warning')).includes('สูงสุด'));
    await m.click('#cbGo');
    await m.waitForSelector('#confirmOrder');
    await shot(m, '04-cart');
    // Double click protection
    await m.dblclick('#confirmOrder');
    await m.waitForSelector('.success-check', { timeout: 10000 });
    await shot(m, '05-order-success');
    const orderNo = (await m.textContent('.order-no')).trim();
    check('order number format', /^ORD-260925-\d{4}$/.test(orderNo), orderNo);
    const hdr = env.sheetHeader('07_ORDERS');
    const empOrders = env.sheetRows('07_ORDERS').filter((r) => r[hdr.indexOf('employee_code')] === 'EMP00125');
    check('double click created exactly one order', empOrders.length === 1, 'orders=' + empOrders.length);
    check('QR code rendered', !!(await m.$('.qr-box svg, .qr-box .mono')));
    await m.click('#sMine');
    await m.waitForSelector('.order-card');
    await shot(m, '06-my-orders');
    // edit order
    await m.click('[data-edit]');
    await m.waitForSelector('.alert-warning');
    await m.click('#cbGo');
    await m.waitForSelector('#confirmOrder');
    await m.click('[data-dec]');
    await m.click('#confirmOrder');
    await m.waitForSelector('.success-check');
    check('edit order saved', true);
    await m.click('#sMine');
    await m.waitForSelector('[data-cancel]');
    await m.click('.tab[data-tab="history"]');
    await m.waitForSelector('.empty, .order-card');
    await m.click('.tab[data-tab="today"]');
    await m.waitForSelector('[data-cancel]');
    await m.click('.mobile-nav button[data-view="more"]');
    await m.waitForSelector('.list-menu');
    await shot(m, '06b-more');
    await m.setViewportSize({ width: 320, height: 640 });
    await m.click('.mobile-nav button[data-view="order"]');
    await m.waitForSelector('.menu-card');
    check('320px no horizontal scroll', await noHScroll(m));
    await shot(m, '03c-menu-320');
    await m.setViewportSize({ width: 768, height: 1024 });
    check('768px no horizontal scroll', await noHScroll(m));

    /* ---------------- Kitchen (desktop) ---------------- */
    console.log('Kitchen flow');
    const k = await newPage(browser, { width: 1366, height: 900 }, errors, 'kitchen');
    await login(k, url, 'KIT001', pins.KIT001);
    await k.waitForSelector('.kpi-grid');
    await k.waitForTimeout(300);
    await shot(k, '07-kitchen-dashboard');
    check('kitchen KPI shows 1 order', (await k.textContent('.kpi-grid .kpi-card:first-child .kpi-value')).trim() === '1');
    await k.click('.nav-item[data-page="k-orders"]');
    await k.waitForSelector('#olTable table');
    await shot(k, '08-kitchen-orders');
    await k.fill('#olQ', 'nobody-xyz');
    await k.waitForSelector('#olTable .empty');
    check('search filters to empty state', (await k.textContent('#olTable .empty h3')).includes('ไม่พบ'));
    await k.fill('#olQ', 'สมชาย');
    await k.waitForSelector('#olTable table');
    await k.click('[data-next]');
    await k.waitForSelector('.toast-success');
    await k.waitForTimeout(400);
    check('status advanced to PREPARING', (await k.textContent('#olTable')).includes('กำลังเตรียม'));
    await k.click('.nav-item[data-page="k-pickup"]');
    await k.waitForSelector('#puQ');
    await k.fill('#puQ', 'emp00125');
    await k.press('#puQ', 'Enter');
    await k.waitForSelector('[data-pickup]');
    await shot(k, '09-pickup-found');
    await k.click('[data-pickup]');
    await k.waitForSelector('.modal-footer .btn-success');
    await k.click('.modal-footer .btn-success');
    await k.waitForSelector('.pickup-done');
    await shot(k, '09b-pickup-done');
    await k.fill('#puQ', orderNo);
    await k.press('#puQ', 'Enter');
    await k.waitForSelector('.pickup-done.warn');
    check('second pickup shows already picked up', (await k.textContent('.pickup-done.warn')).includes('รับอาหารไปแล้ว'));
    await k.click('.nav-item[data-page="k-summary"]');
    await k.waitForSelector('.page-head #fsDate');
    await shot(k, '10-final-summary');
    await k.click('.nav-item[data-page="k-daily"]');
    await k.waitForSelector('#dmTable table');
    await k.click('.nav-item[data-page="reports"]');
    await k.waitForSelector('#rpBody .kpi-grid');
    await k.click('.nav-item[data-page="k-settings"]');
    await k.waitForSelector('#ksPin');
    await k.setViewportSize({ width: 768, height: 1024 });
    await k.click('#sbOpen');
    await k.waitForTimeout(300);
    await shot(k, '07b-kitchen-tablet-nav');
    await k.click('#sbBackdrop');
    check('kitchen 768 no horizontal scroll', await noHScroll(k));

    /* ---------------- Admin ---------------- */
    console.log('Admin flow');
    const a = await newPage(browser, { width: 1440, height: 900 }, errors, 'admin');
    await login(a, url, 'ADMIN01', pins.ADMIN01);
    await a.waitForSelector('#pinSave');
    check('first admin forced to change PIN', true);
    await a.fill('#pinCur', pins.ADMIN01);
    await a.fill('#pinNew', '731946');
    await a.fill('#pinNew2', '731946');
    await a.click('#pinSave');
    await a.waitForSelector('.kpi-grid');
    await a.waitForTimeout(300);
    await shot(a, '11-admin-dashboard');
    const pages = ['k-dashboard', 'k-pickup', 'k-summary', 'menu', 'daily', 'meals', 'employees', 'orders', 'reports', 'line', 'audit', 'logs', 'settings', 'backup'];
    for (const p of pages) {
      await a.click('.nav-item[data-page="' + p + '"]');
      await a.waitForFunction(() => !document.querySelector('#content .page-loading'), null, { timeout: 8000 });
      await a.waitForTimeout(250);
      await shot(a, '12-admin-' + p);
      check('admin page renders: ' + p, !(await a.$('#content .empty h3:text("โหลดข้อมูลไม่สำเร็จ")')));
    }
    // Meal windows: create a dinner by mistake, edit it, then delete it
    await a.click('.nav-item[data-page="meals"]');
    await a.waitForSelector('#mwTable table');
    await a.click('#mwAdd');
    await a.selectOption('#f_meal', 'DINNER');
    await a.click('.modal-footer .btn-primary');
    await a.waitForSelector('.toast-success');
    await a.waitForFunction(() => document.querySelectorAll('#mwTable [data-del]').length === 2);
    check('every meal row has edit + delete buttons', (await a.$$('#mwTable [data-edit]')).length === 2);
    await a.click('#mwTable tr:has-text("มื้อเย็น") [data-edit]');
    await a.fill('#f_close', '16:00');
    await a.click('.modal-footer .btn-primary');
    await a.waitForFunction(() => document.querySelector('#mwTable').textContent.includes('16:00'));
    check('meal time edited', true);
    await a.click('#mwTable tr:has-text("มื้อเย็น") [data-del]');
    await a.click('.modal-footer .btn-danger');
    await a.waitForFunction(() => document.querySelectorAll('#mwTable [data-del]').length === 1);
    check('meal deleted', !(await a.textContent('#mwTable')).includes('มื้อเย็น'));
    await shot(a, '12b-admin-meals-actions');
    // Add a menu
    await a.click('.nav-item[data-page="menu"]');
    await a.waitForSelector('#mnAdd');
    await a.click('#mnAdd');
    await a.fill('#f_name', 'ผัดซีอิ๊วหมู');
    await a.fill('#f_default_price', '40');
    await a.fill('#f_default_stock', '25');
    await shot(a, '13-admin-menu-form');
    await a.click('.modal-footer .btn-primary');
    await a.waitForSelector('.toast-success');
    await a.waitForTimeout(300);
    check('menu added', (await a.textContent('#mnTable')).includes('ผัดซีอิ๊วหมู'));
    // Add an employee
    await a.click('.nav-item[data-page="employees"]');
    await a.waitForSelector('#emAdd');
    await a.click('#emAdd');
    await a.fill('#f_employee_code', 'EMP00300');
    await a.fill('#f_name', 'ทดสอบ อีทูอี');
    await a.click('.modal-footer .btn-primary');
    await a.waitForSelector('.modal .order-no');
    const newPin = (await a.textContent('.modal .order-no')).trim();
    check('new employee PIN shown once', /^\d{6}$/.test(newPin), newPin);
    await shot(a, '14-admin-employee-pin');
    await a.click('.modal-footer .btn-primary');
    // Settings save
    await a.click('.nav-item[data-page="settings"]');
    await a.waitForSelector('#stSave');
    await a.fill('#f_MAX_QTY_PER_ORDER', '4');
    await a.click('#stSave');
    await a.waitForSelector('.toast-success:has-text("บันทึกแล้ว")');
    check('settings saved', true);
    // Collapse sidebar
    await a.click('#sbCollapse');
    await a.waitForTimeout(250);
    check('sidebar collapses', await a.$eval('#shell', (e) => e.classList.contains('collapsed')));
    await a.setViewportSize({ width: 1920, height: 1080 });
    await a.click('.nav-item[data-page="reports"]');
    await a.waitForSelector('#rpBody .kpi-grid');
    await shot(a, '16-reports-1920');
    check('1920 no horizontal scroll', await noHScroll(a));
    await a.click('#sbCollapse');
    await a.setViewportSize({ width: 1024, height: 768 });
    check('1024 no horizontal scroll', await noHScroll(a));

    /* ---------------- Viewer ---------------- */
    console.log('Viewer flow');
    const v = await newPage(browser, { width: 1366, height: 900 }, errors, 'viewer');
    await login(v, url, 'VIEW001', pins.VIEW001);
    await v.waitForSelector('.kpi-grid');
    const navs = await v.$$eval('.nav-item[data-page]', (els) => els.map((e) => e.dataset.page));
    check('viewer sees only dashboard + reports', JSON.stringify(navs) === JSON.stringify(['a-dashboard', 'reports']), navs.join(','));
    await shot(v, '17-viewer-dashboard');

    /* ---------------- Logout ---------------- */
    await v.click('#navLogout');
    await v.click('.modal-footer .btn-primary');
    await v.waitForSelector('#empCode');
    check('logout returns to login', true);
  } catch (e) {
    console.error('E2E FAILURE:', e);
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) { try { await pg.screenshot({ path: path.join(OUT, 'zz-failure-' + Math.random().toString(36).slice(2, 6) + '.png') }); } catch (x) { /* ignore */ } }
    results.push({ name: 'exception', ok: false, detail: String(e && e.message) });
  } finally {
    await browser.close();
    server.close();
  }
  check('no JavaScript errors in console', errors.length === 0, errors.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();

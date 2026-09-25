/**
 * MealService.gs
 * ---------------------------------------------------------------------------
 * Meal windows (BREAKFAST / LUNCH / DINNER) with open/close/pickup times.
 *
 * Status lifecycle:  DRAFT -> OPEN -> CLOSED -> PREPARING -> COMPLETED
 *  - auto = TRUE : status follows the clock (scheduler persists transitions)
 *  - auto = FALSE: status set manually by admin (any manual change sets auto=FALSE)
 * Regardless of status, ordering is ALWAYS rejected at/after close_at (hard cutoff).
 */

/**
 * Computes the status a window should have at `now`.
 * @param {Object} w window row
 * @param {string} now "yyyy-MM-dd HH:mm:ss"
 * @return {string}
 */
function computeWindowStatus(w, now) {
  if (w.status === WINDOW_STATUS.COMPLETED) return WINDOW_STATUS.COMPLETED;
  if (!toBool(w.auto)) {
    if (w.status === WINDOW_STATUS.OPEN && now >= w.close_at) return WINDOW_STATUS.CLOSED;
    return w.status;
  }
  var target;
  if (now < w.open_at) target = WINDOW_STATUS.DRAFT;
  else if (now < w.close_at) target = WINDOW_STATUS.OPEN;
  else if (now < w.pickup_start) target = WINDOW_STATUS.CLOSED;
  else if (now < w.pickup_end) target = WINDOW_STATUS.PREPARING;
  else target = WINDOW_STATUS.COMPLETED;
  // Auto mode only moves forward.
  return WINDOW_STATUSES.indexOf(target) >= WINDOW_STATUSES.indexOf(w.status) ? target : w.status;
}

/** True when employees may create/edit/cancel orders for this window now. */
function isWindowOrderable(w, now) {
  return computeWindowStatus(w, now) === WINDOW_STATUS.OPEN && now < w.close_at;
}

/** Throws the proper error when the window is not orderable. */
function assertWindowOrderable(w, now) {
  assert(w, 'MEAL_NOT_FOUND');
  if (isWindowOrderable(w, now)) return;
  var st = computeWindowStatus(w, now);
  if (st === WINDOW_STATUS.DRAFT) fail('MEAL_NOT_OPEN', ERR.MEAL_NOT_OPEN + ' (เปิด ' + hhmm(w.open_at) + ' น.)');
  fail('MEAL_CLOSED', ERR.MEAL_CLOSED + ' (ปิดรับ ' + hhmm(w.close_at) + ' น.)');
}

/** Client representation of a window. */
function windowToClient(w, now) {
  now = now || nowStr();
  var status = computeWindowStatus(w, now);
  return {
    window_id: w.window_id,
    date: w.date,
    date_th: thaiDate(w.date),
    meal: w.meal,
    meal_th: MEAL_LABEL_TH[w.meal] || w.meal,
    open_at: w.open_at,
    close_at: w.close_at,
    pickup_start: w.pickup_start,
    pickup_end: w.pickup_end,
    status: status,
    stored_status: w.status,
    auto: toBool(w.auto),
    note: w.note,
    can_order: isWindowOrderable(w, now),
    seconds_to_open: Math.max(0, Math.floor(diffMs(now, w.open_at) / 1000)),
    seconds_to_close: Math.max(0, Math.floor(diffMs(now, w.close_at) / 1000)),
    final_sent_at: w.final_sent_at,
    is_sample: toBool(w.is_sample)
  };
}

/** Returns the window row by id or throws MEAL_NOT_FOUND. */
function getWindowById(windowId) {
  var w = dbFindOne('MEAL_WINDOWS', 'window_id', String(windowId || ''));
  assert(w, 'MEAL_NOT_FOUND');
  return w;
}

/** Windows for a date sorted by meal order. */
function getWindowsByDate(dateStr) {
  return dbFind('MEAL_WINDOWS', 'date', dateStr).sort(function (a, b) {
    return MEAL_TYPES.indexOf(a.meal) - MEAL_TYPES.indexOf(b.meal);
  });
}

/**
 * Picks the most relevant window of a list: OPEN > upcoming DRAFT > in pickup > latest.
 */
function pickCurrentWindow(windows, now) {
  if (!windows.length) return null;
  var withStatus = windows.map(function (w) { return { w: w, s: computeWindowStatus(w, now) }; });
  var pick = function (s) { return withStatus.filter(function (x) { return x.s === s; }); };
  var open = pick('OPEN');
  if (open.length) return open[0].w;
  var active = pick('CLOSED').concat(pick('PREPARING'));
  var drafts = pick('DRAFT').sort(function (a, b) { return a.w.open_at < b.w.open_at ? -1 : 1; });
  if (active.length) return active[0].w;
  if (drafts.length) return drafts[0].w;
  return windows[windows.length - 1];
}

/** Default times from config for a meal type. */
function defaultTimesFor(meal) {
  return {
    open: normalizeTime(cfg(meal + '_OPEN_TIME')) || '08:00',
    close: normalizeTime(cfg(meal + '_CLOSE_TIME')) || '10:30',
    pickupStart: normalizeTime(cfg(meal + '_PICKUP_START')) || '11:30',
    pickupEnd: normalizeTime(cfg(meal + '_PICKUP_END')) || '13:00'
  };
}

/**
 * Validates and builds window time fields.
 * @return {{open_at, close_at, pickup_start, pickup_end}}
 */
function buildWindowTimes_(date, open, close, pickupStart, pickupEnd) {
  var t = [open, close, pickupStart, pickupEnd].map(normalizeTime);
  assert(t.every(String), 'VALIDATION_ERROR', 'รูปแบบเวลาไม่ถูกต้อง (HH:mm)');
  var r = {
    open_at: combineDateTime(date, t[0]),
    close_at: combineDateTime(date, t[1]),
    pickup_start: combineDateTime(date, t[2]),
    pickup_end: combineDateTime(date, t[3])
  };
  assert(r.open_at < r.close_at, 'VALIDATION_ERROR', 'เวลาเปิดต้องก่อนเวลาปิดรับจอง');
  assert(r.close_at <= r.pickup_start, 'VALIDATION_ERROR', 'เวลาเริ่มรับอาหารต้องไม่ก่อนเวลาปิดรับจอง');
  assert(r.pickup_start < r.pickup_end, 'VALIDATION_ERROR', 'เวลาเริ่มรับอาหารต้องก่อนเวลาสิ้นสุด');
  return r;
}

/** Validates yyyy-MM-dd. */
function validateDateStr(d) {
  var s = String(d || '').trim();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(s) && parseLocal(s), 'VALIDATION_ERROR', 'รูปแบบวันที่ไม่ถูกต้อง');
  return s;
}

/**
 * Creates a window row (caller must hold the lock).
 * @return {Object} window row
 */
function createWindow_(date, meal, times, opts) {
  opts = opts || {};
  var now = nowStr();
  var row = dbInsert('MEAL_WINDOWS', {
    window_id: uuid(),
    date: date,
    meal: meal,
    open_at: times.open_at,
    close_at: times.close_at,
    pickup_start: times.pickup_start,
    pickup_end: times.pickup_end,
    status: opts.status || WINDOW_STATUS.DRAFT,
    auto: opts.auto === false ? 'FALSE' : 'TRUE',
    note: sanitizeText(opts.note, 200),
    last_summary_at: '',
    final_sent_at: '',
    created_at: now,
    updated_at: now,
    created_by: opts.createdBy || 'SYSTEM',
    is_sample: opts.isSample ? 'TRUE' : 'FALSE'
  });
  if (opts.copyMenu) copyMasterToDailyMenu_(row);
  return row;
}

/**
 * Ensures today's default windows exist (AUTO_CREATE_WINDOW).
 * Cheap check first, then lock + re-check to avoid duplicates.
 * @return {number} windows created
 */
function ensureWindowsForDate(dateStr) {
  if (!cfgBool('AUTO_CREATE_WINDOW')) return 0;
  var days = cfgList('WORKING_DAYS').map(function (x) { return toInt(x, -1); });
  if (days.length && days.indexOf(dayOfWeek(dateStr)) < 0) return 0;
  var meals = cfgList('DEFAULT_MEALS').map(function (m) { return m.toUpperCase(); })
    .filter(function (m) { return MEAL_TYPES.indexOf(m) >= 0; });
  if (!meals.length) return 0;
  var existing = getWindowsByDate(dateStr).map(function (w) { return w.meal; });
  var missing = meals.filter(function (m) { return existing.indexOf(m) < 0; });
  if (!missing.length) return 0;
  return withLock(function () {
    var ex2 = getWindowsByDate(dateStr).map(function (w) { return w.meal; });
    var created = 0;
    meals.forEach(function (m) {
      if (ex2.indexOf(m) >= 0) return;
      var d = defaultTimesFor(m);
      createWindow_(dateStr, m, buildWindowTimes_(dateStr, d.open, d.close, d.pickupStart, d.pickupEnd),
        { auto: true, copyMenu: cfgBool('AUTO_DAILY_MENU') });
      created++;
    });
    if (created) systemLog('INFO', 'MEAL', 'AUTO_CREATE_WINDOW', 'สร้างมื้ออาหารอัตโนมัติ ' + dateStr, { created: created });
    return created;
  });
}

/**
 * Lists windows in a date range (default: 7 days back to 14 days ahead).
 * @param {{from:string, to:string}} p
 */
function listWindows(user, p) {
  p = p || {};
  var today = todayStr();
  var from = p.from ? validateDateStr(p.from) : addDays(today, -7);
  var to = p.to ? validateDateStr(p.to) : addDays(today, 14);
  var now = nowStr();
  var dmCount = {};
  var windows = dbAll('MEAL_WINDOWS').filter(function (w) { return w.date >= from && w.date <= to; });
  if (windows.length) {
    var ids = {};
    windows.forEach(function (w) { ids[w.window_id] = true; });
    dbAll('DAILY_MENU').forEach(function (d) {
      if (ids[d.window_id] && d.status !== 'REMOVED') {
        var c = dmCount[d.window_id] = dmCount[d.window_id] || { items: 0, sold: 0, stock: 0 };
        c.items++; c.sold += toInt(d.sold_qty); c.stock += toInt(d.stock_limit);
      }
    });
  }
  var rows = windows.map(function (w) {
    var c = windowToClient(w, now);
    var m = dmCount[w.window_id] || { items: 0, sold: 0, stock: 0 };
    c.menu_count = m.items; c.sold_qty = m.sold; c.stock_total = m.stock;
    return c;
  }).sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return MEAL_TYPES.indexOf(a.meal) - MEAL_TYPES.indexOf(b.meal);
  });
  return { rows: rows, from: from, to: to, defaults: MEAL_TYPES.map(function (m) { return { meal: m, times: defaultTimesFor(m) }; }) };
}

/**
 * Creates or updates a meal window.
 * @param {{window_id?, date, meal, open, close, pickup_start, pickup_end, note, auto, copy_menu}} p
 */
function saveWindow(user, p) {
  p = p || {};
  var date = validateDateStr(p.date);
  var meal = String(p.meal || '').toUpperCase();
  assert(MEAL_TYPES.indexOf(meal) >= 0, 'VALIDATION_ERROR', 'มื้ออาหารไม่ถูกต้อง');
  var times = buildWindowTimes_(date, p.open, p.close, p.pickup_start, p.pickup_end);
  return withLock(function () {
    var now = nowStr();
    var dup = getWindowsByDate(date).filter(function (w) { return w.meal === meal && w.window_id !== p.window_id; });
    assert(!dup.length, 'VALIDATION_ERROR', 'มี' + MEAL_LABEL_TH[meal] + 'ของวันที่นี้อยู่แล้ว');
    if (p.window_id) {
      var w = getWindowById(p.window_id);
      assert(w.status !== WINDOW_STATUS.COMPLETED, 'VALIDATION_ERROR', 'มื้อนี้จบแล้ว ไม่สามารถแก้ไขได้');
      if (w.date !== date || w.meal !== meal) {
        var orders = dbFind('ORDERS', 'window_id', w.window_id);
        assert(!orders.length, 'VALIDATION_ERROR', 'มี Order แล้ว ไม่สามารถเปลี่ยนวันที่/มื้อได้');
      }
      var changes = {
        date: date, meal: meal, open_at: times.open_at, close_at: times.close_at,
        pickup_start: times.pickup_start, pickup_end: times.pickup_end,
        note: sanitizeText(p.note, 200), auto: toBool(p.auto) ? 'TRUE' : 'FALSE', updated_at: now
      };
      var d = diffFields(w, changes, ['date', 'meal', 'open_at', 'close_at', 'pickup_start', 'pickup_end', 'note', 'auto']);
      dbUpdate('MEAL_WINDOWS', w, changes);
      if (w.date !== date || w.meal !== meal) {
        var dms = dbFind('DAILY_MENU', 'window_id', w.window_id);
        dbUpdateMany('DAILY_MENU', dms.map(function (x) { return { row: x, changes: { date: date, meal: meal } }; }));
      }
      if (d.changed) writeAudit(user, 'UPDATE_MEAL_WINDOW', 'MEAL', w.window_id, d.old, d.new);
      return { window: windowToClient(w, now) };
    }
    var row = createWindow_(date, meal, times, {
      auto: p.auto === undefined ? true : toBool(p.auto), note: p.note, createdBy: user.employee_code,
      copyMenu: p.copy_menu === undefined ? true : toBool(p.copy_menu)
    });
    writeAudit(user, 'CREATE_MEAL_WINDOW', 'MEAL', row.window_id, '', { date: date, meal: meal });
    return { window: windowToClient(row, now) };
  });
}

/**
 * Manually sets a window status (turns auto off). Runs close/complete hooks.
 * @param {{window_id:string, status:string}} p
 */
function setWindowStatus(user, p) {
  var status = String(p && p.status || '').toUpperCase();
  assert(WINDOW_STATUSES.indexOf(status) >= 0, 'VALIDATION_ERROR', 'สถานะไม่ถูกต้อง');
  var result = withLock(function () {
    var w = getWindowById(p.window_id);
    var now = nowStr();
    var old = computeWindowStatus(w, now);
    if (status === WINDOW_STATUS.OPEN) {
      assert(now < w.close_at, 'VALIDATION_ERROR', 'เลยเวลาปิดรับจองแล้ว กรุณาแก้ไขเวลาปิดก่อนเปิดมื้อ');
    }
    dbUpdate('MEAL_WINDOWS', w, { status: status, auto: 'FALSE', updated_at: now });
    writeAudit(user, 'SET_MEAL_STATUS', 'MEAL', w.window_id, old, status);
    return { w: w, old: old };
  });
  runWindowHooks_(result.w, result.old, status);
  return { window: windowToClient(result.w) };
}

/**
 * Sets auto mode back on for a window (status then follows the clock).
 */
function setWindowAuto(user, p) {
  return withLock(function () {
    var w = getWindowById(p && p.window_id);
    dbUpdate('MEAL_WINDOWS', w, { auto: 'TRUE', updated_at: nowStr() });
    writeAudit(user, 'SET_MEAL_AUTO', 'MEAL', w.window_id, 'FALSE', 'TRUE');
    return { window: windowToClient(w) };
  });
}

/**
 * Persists time-based status transitions for recent windows and runs hooks.
 * Called by the scheduler trigger.
 * @return {number} transitions applied
 */
function syncWindowStatuses() {
  var now = nowStr();
  var today = todayStr();
  var from = addDays(today, -2);
  var candidates = dbAll('MEAL_WINDOWS').filter(function (w) {
    return w.date >= from && w.date <= today && w.status !== WINDOW_STATUS.COMPLETED;
  });
  var changed = [];
  candidates.forEach(function (w) {
    var target = computeWindowStatus(w, now);
    if (target !== w.status) changed.push({ w: w, from: w.status, to: target });
  });
  if (!changed.length) return 0;
  withLock(function () {
    changed.forEach(function (c) {
      var fresh = getWindowById(c.w.window_id);
      var target = computeWindowStatus(fresh, nowStr());
      if (target === fresh.status) { c.skip = true; return; }
      c.from = fresh.status; c.to = target;
      dbUpdate('MEAL_WINDOWS', fresh, { status: target, updated_at: nowStr() });
      c.w = fresh;
    });
  });
  changed.forEach(function (c) {
    if (c.skip) return;
    systemLog('INFO', 'MEAL', 'STATUS_' + c.to, MEAL_LABEL_TH[c.w.meal] + ' ' + c.w.date + ': ' + c.from + ' → ' + c.to);
    runWindowHooks_(c.w, c.from, c.to);
  });
  return changed.length;
}

/**
 * Side effects after a status change. Each hook is isolated so a failure in a
 * secondary service (LINE / summary) never blocks the core system.
 */
function runWindowHooks_(w, from, to) {
  var order = WINDOW_STATUSES;
  var passedClose = order.indexOf(to) >= order.indexOf(WINDOW_STATUS.CLOSED) &&
    order.indexOf(from) < order.indexOf(WINDOW_STATUS.CLOSED);
  if (passedClose || (to === WINDOW_STATUS.CLOSED && !w.final_sent_at)) {
    try { onWindowClosed(w); } catch (e) { logError(e, 'MEAL', 'onWindowClosed'); }
  }
  if (to === WINDOW_STATUS.COMPLETED) {
    try { onWindowCompleted(w); } catch (e) { logError(e, 'MEAL', 'onWindowCompleted'); }
  }
}

/** Close hook: daily summary + final LINE summary (once). */
function onWindowClosed(w) {
  try { upsertDailySummary(w.window_id); } catch (e) { logError(e, 'MEAL', 'upsertDailySummary'); }
  if (!w.final_sent_at) {
    enqueueFinalSummary(w);
    var fresh = getWindowById(w.window_id);
    dbUpdate('MEAL_WINDOWS', fresh, { final_sent_at: nowStr() });
    w.final_sent_at = fresh.final_sent_at;
  }
}

/** Completion hook: mark unclaimed orders NO_SHOW (if enabled) + refresh summary. */
function onWindowCompleted(w) {
  if (cfgBool('AUTO_NO_SHOW')) {
    withLock(function () {
      var now = nowStr();
      var orders = dbFind('ORDERS', 'window_id', w.window_id).filter(function (o) {
        return [ORDER_STATUS.CONFIRMED, ORDER_STATUS.PREPARING, ORDER_STATUS.READY].indexOf(o.status) >= 0;
      });
      if (!orders.length) return;
      var logs = orders.map(function (o) {
        return {
          log_id: uuid(), order_id: o.order_id, order_no: o.order_no, from_status: o.status,
          to_status: ORDER_STATUS.NO_SHOW, changed_by: 'SYSTEM', changed_by_role: 'SYSTEM',
          reason: 'ไม่มารับภายในเวลา', created_at: now
        };
      });
      dbUpdateMany('ORDERS', orders.map(function (o) {
        return { row: o, changes: { status: ORDER_STATUS.NO_SHOW, updated_at: now, version: toInt(o.version) + 1 } };
      }));
      dbInsertMany('ORDER_STATUS_LOG', logs);
      systemLog('INFO', 'MEAL', 'AUTO_NO_SHOW', 'เปลี่ยนเป็นไม่มารับ ' + orders.length + ' รายการ', { window_id: w.window_id });
    });
  }
  try { upsertDailySummary(w.window_id); } catch (e) { logError(e, 'MEAL', 'upsertDailySummary'); }
}

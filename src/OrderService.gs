/**
 * OrderService.gs
 * ---------------------------------------------------------------------------
 * Order lifecycle: create, edit, cancel, status change, pickup.
 *
 * Critical rules (all enforced server-side, inside LockService):
 *  - session / user status (Router), meal window + hard cutoff, stock, per-item
 *    and per-order max qty, existing order, current server price, idempotency.
 *  - Stock counters (06_DAILY_MENU.sold_qty) are only changed under the lock,
 *    so two employees ordering the last box concurrently can never oversell.
 *  - LINE notifications are queued AFTER commit; they never affect success.
 */

var ORDER_STATUS_TH = {
  CONFIRMED: 'ยืนยันแล้ว', PREPARING: 'กำลังเตรียม', READY: 'พร้อมรับ',
  PICKED_UP: 'รับแล้ว', CANCELLED: 'ยกเลิก', NO_SHOW: 'ไม่มารับ'
};
var MAX_LINES_PER_ORDER = 20;

/**
 * Validates and merges the requested items.
 * @return {Array<{daily_menu_id:string, qty:number, note:string}>}
 */
function normalizeOrderItems_(items) {
  assert(Array.isArray(items) && items.length > 0, 'INVALID_QTY', 'กรุณาเลือกเมนูอย่างน้อย 1 รายการ');
  assert(items.length <= MAX_LINES_PER_ORDER, 'INVALID_QTY', 'จำนวนรายการมากเกินไป');
  var merged = {};
  var order = [];
  items.forEach(function (it) {
    var id = String(it && it.daily_menu_id || '');
    assert(/^[0-9a-fA-F\-]{36}$/.test(id), 'MENU_NOT_FOUND');
    var qty = Number(it.qty);
    assert(Math.floor(qty) === qty && qty >= 1 && qty <= 100, 'INVALID_QTY');
    if (!merged[id]) { merged[id] = { daily_menu_id: id, qty: 0, note: '' }; order.push(id); }
    merged[id].qty += qty;
    var n = sanitizeText(it.note, 100);
    if (n) merged[id].note = n;
  });
  return order.map(function (id) { return merged[id]; });
}

/** Validates the client idempotency token. */
function validateRequestToken_(t) {
  var s = String(t || '');
  assert(/^[A-Za-z0-9\-]{16,64}$/.test(s), 'VALIDATION_ERROR', 'request_token ไม่ถูกต้อง');
  return s;
}

/**
 * Checks items against daily menu rows. `released` maps daily_menu_id -> qty
 * currently held by the order being edited (added back to availability).
 * @return {{lines:Array, totalQty:number, totalAmount:number, stockUpdates:Object}}
 */
function priceAndCheckItems_(w, reqItems, released) {
  released = released || {};
  var dmRows = dbFind('DAILY_MENU', 'window_id', w.window_id);
  var dmById = indexBy(dmRows, 'daily_menu_id');
  var maxPerOrder = Math.max(1, cfgInt('MAX_QTY_PER_ORDER', 3));
  var lines = [], totalQty = 0, totalAmount = 0;
  reqItems.forEach(function (it) {
    var d = dmById[it.daily_menu_id];
    assert(d && d.window_id === w.window_id && d.status !== 'REMOVED', 'MENU_NOT_FOUND');
    var available = toInt(d.stock_limit) - toInt(d.sold_qty) + (released[d.daily_menu_id] || 0);
    if (d.status !== 'AVAILABLE' || available <= 0) {
      fail('MENU_SOLD_OUT', 'เมนู "' + d.item_name + '" หมดแล้ว', { daily_menu_id: d.daily_menu_id, remaining: 0 });
    }
    if (it.qty > available) {
      fail('MENU_SOLD_OUT', 'เมนู "' + d.item_name + '" เหลือเพียง ' + available + ' กล่อง',
        { daily_menu_id: d.daily_menu_id, remaining: available });
    }
    var itemMax = toInt(d.max_per_order);
    if (itemMax > 0 && it.qty > itemMax) {
      fail('INVALID_QTY', 'เมนู "' + d.item_name + '" สั่งได้สูงสุด ' + itemMax + ' กล่องต่อ Order');
    }
    var price = roundMoney(d.price);
    lines.push({ d: d, qty: it.qty, note: it.note, unit_price: price, subtotal: roundMoney(price * it.qty) });
    totalQty += it.qty;
    totalAmount = roundMoney(totalAmount + price * it.qty);
  });
  if (totalQty > maxPerOrder) fail('INVALID_QTY', 'สั่งได้สูงสุด ' + maxPerOrder + ' กล่องต่อ Order');
  return { lines: lines, totalQty: totalQty, totalAmount: totalAmount, dmById: dmById };
}

/** Builds the compact items_json stored on the order row. */
function itemsJson_(lines) {
  return JSON.stringify(lines.map(function (l) {
    return { id: l.d.daily_menu_id, item: l.d.item_id, n: l.d.item_name, q: l.qty, p: l.unit_price, note: l.note || '' };
  }));
}

/** Parses items_json into client items. */
function parseOrderItems(o) {
  return safeJsonParse(o.items_json, []).map(function (x) {
    return {
      daily_menu_id: x.id, item_id: x.item, name: x.n, qty: toInt(x.q), unit_price: toNum(x.p),
      subtotal: roundMoney(toNum(x.p) * toInt(x.q)), note: x.note || ''
    };
  });
}

/** Next order number ORD-YYMMDD-XXXX (caller holds lock). */
function nextOrderNo_(orderDate) {
  var ymd = orderDate.substring(2, 4) + orderDate.substring(5, 7) + orderDate.substring(8, 10);
  var key = 'SEQ_' + ymd;
  var props = PropertiesService.getScriptProperties();
  var cur = toInt(props.getProperty(key), -1);
  if (cur < 0) {
    cur = 0;
    dbFind('ORDERS', 'order_date', orderDate).forEach(function (o) {
      var m = String(o.order_no).match(/-(\d+)$/);
      if (m) cur = Math.max(cur, parseInt(m[1], 10));
    });
  }
  cur++;
  props.setProperty(key, String(cur));
  return 'ORD-' + ymd + '-' + pad(cur, 4);
}

/**
 * Converts an order row into the client format.
 * @param {Object} o order row
 * @param {Object=} w window row (for can_edit / can_cancel)
 */
function orderToClient(o, w) {
  var now = nowStr();
  var orderable = w ? isWindowOrderable(w, now) : false;
  var isConfirmed = o.status === ORDER_STATUS.CONFIRMED;
  return {
    order_id: o.order_id,
    order_no: o.order_no,
    employee_id: o.employee_id,
    employee_code: o.employee_code,
    employee_name: o.employee_name,
    department: o.department,
    window_id: o.window_id,
    order_date: o.order_date,
    order_date_th: thaiDate(o.order_date),
    meal: o.meal,
    meal_th: MEAL_LABEL_TH[o.meal] || o.meal,
    status: o.status,
    status_th: ORDER_STATUS_TH[o.status] || o.status,
    total_qty: toInt(o.total_qty),
    total_amount: toNum(o.total_amount),
    items: parseOrderItems(o),
    note: o.note,
    created_at: o.created_at,
    updated_at: o.updated_at,
    cancelled_at: o.cancelled_at,
    picked_up_at: o.picked_up_at,
    picked_up_by: o.picked_up_by,
    version: toInt(o.version),
    can_edit: orderable && isConfirmed && cfgBool('ALLOW_EDIT'),
    can_cancel: orderable && isConfirmed && cfgBool('ALLOW_CANCEL'),
    close_at: w ? w.close_at : '',
    pickup_start: w ? w.pickup_start : '',
    pickup_end: w ? w.pickup_end : ''
  };
}

/** Status log row. */
function statusLogRow_(o, from, to, user, reason) {
  return {
    log_id: uuid(), order_id: o.order_id, order_no: o.order_no, from_status: from, to_status: to,
    changed_by: user ? user.employee_code : 'SYSTEM', changed_by_role: user ? user.role : 'SYSTEM',
    reason: sanitizeText(reason, 200), created_at: nowStr()
  };
}

/**
 * Creates an order.
 * @param {Object} user current user (from session)
 * @param {{window_id:string, items:Array, note:string, request_token:string, expected_total?:number}} p
 * @return {{order:Object, duplicate:boolean}}
 */
function createOrder(user, p) {
  p = p || {};
  var token = validateRequestToken_(p.request_token);
  var reqItems = normalizeOrderItems_(p.items);
  var note = sanitizeText(p.note, 200);

  var result = withLock(function () {
    // 1) Idempotency: same request token -> return the original order.
    var dup = dbFindOne('ORDERS', 'request_token', token);
    if (dup) {
      assert(dup.employee_id === user.employee_id, 'DUPLICATE_REQUEST');
      return { order: dup, duplicate: true };
    }
    // 2) Meal window + cutoff.
    var w = getWindowById(p.window_id);
    var now = nowStr();
    assertWindowOrderable(w, now);
    // 3) Existing order in this window.
    var windowOrders = dbFind('ORDERS', 'window_id', w.window_id);
    if (!cfgBool('ALLOW_MULTIPLE_ORDERS')) {
      var mine = windowOrders.filter(function (o) {
        return o.employee_id === user.employee_id && o.status !== ORDER_STATUS.CANCELLED;
      });
      if (mine.length) fail('ORDER_EXISTS', ERR.ORDER_EXISTS, { order_id: mine[0].order_id, order_no: mine[0].order_no });
    }
    // 4) Stock / qty / current price.
    var checked = priceAndCheckItems_(w, reqItems);
    if (p.expected_total !== undefined && p.expected_total !== null &&
      roundMoney(p.expected_total) !== checked.totalAmount) {
      fail('PRICE_CHANGED', ERR.PRICE_CHANGED + ' (ยอดใหม่ ' + checked.totalAmount + ' บาท)', { total_amount: checked.totalAmount });
    }
    // 5) Persist.
    var orderId = uuid();
    var orderNo = nextOrderNo_(w.date);
    var order = dbInsert('ORDERS', {
      order_id: orderId, order_no: orderNo, employee_id: user.employee_id, employee_code: user.employee_code,
      employee_name: user.name, department: user.department, window_id: w.window_id, order_date: w.date,
      meal: w.meal, status: ORDER_STATUS.CONFIRMED, total_qty: checked.totalQty, total_amount: checked.totalAmount,
      items_json: itemsJson_(checked.lines), note: note, request_token: token, created_at: now, updated_at: now,
      cancelled_at: '', cancelled_by: '', picked_up_at: '', picked_up_by: '', version: 1, is_sample: 'FALSE'
    });
    dbInsertMany('ORDER_ITEMS', checked.lines.map(function (l) {
      return {
        order_item_id: uuid(), order_id: orderId, window_id: w.window_id, daily_menu_id: l.d.daily_menu_id,
        item_id: l.d.item_id, item_name_snapshot: l.d.item_name, qty: l.qty, unit_price: l.unit_price,
        subtotal: l.subtotal, item_note: l.note || '', status: 'ACTIVE', created_at: now, is_sample: 'FALSE'
      };
    }));
    dbUpdateMany('DAILY_MENU', checked.lines.map(function (l) {
      return { row: l.d, changes: { sold_qty: toInt(l.d.sold_qty) + l.qty, updated_at: now } };
    }));
    dbInsert('ORDER_STATUS_LOG', statusLogRow_(order, '', ORDER_STATUS.CONFIRMED, user, 'สร้าง Order'));
    dbInsert('PAYMENT', {
      payment_id: uuid(), order_id: orderId, order_no: orderNo, employee_id: user.employee_id,
      employee_code: user.employee_code, amount: checked.totalAmount, method: cfg('PAYMENT_METHOD') || 'PAYROLL_DEDUCTION',
      status: 'PENDING', period: w.date.substring(0, 7), created_at: now, updated_at: now, is_sample: 'FALSE'
    });
    return { order: order, window: w, duplicate: false };
  });

  var w = result.window || dbFindOne('MEAL_WINDOWS', 'window_id', result.order.window_id);
  if (!result.duplicate) {
    writeAudit(user, 'CREATE_ORDER', 'ORDER', result.order.order_no, '',
      { qty: result.order.total_qty, amount: result.order.total_amount });
    afterOrderCommitted_(result.order, 'NEW');
  }
  return { order: orderToClient(result.order, w), duplicate: result.duplicate };
}

/** Secondary side-effects after commit (never throw). */
function afterOrderCommitted_(order, kind) {
  try {
    if (cfg('LINE_NOTIFICATION_MODE') === 'INSTANT') enqueueInstantOrder(order, kind);
  } catch (e) {
    logError(e, 'ORDER', 'afterOrderCommitted_');
  }
}

/** Loads an order the user may act on as owner. */
function getOwnOrder_(user, orderId) {
  var o = dbFindOne('ORDERS', 'order_id', String(orderId || ''));
  assert(o, 'ORDER_NOT_FOUND');
  assert(o.employee_id === user.employee_id, 'ACCESS_DENIED');
  return o;
}

/** Active order items of an order. */
function getActiveOrderItems_(order) {
  return dbFind('ORDER_ITEMS', 'order_id', order.order_id).filter(function (i) { return i.status === 'ACTIVE'; });
}

/**
 * Edits an order (owner only, CONFIRMED, before cutoff, ALLOW_EDIT).
 * @param {{order_id:string, items:Array, note:string, version?:number}} p
 */
function updateOrder(user, p) {
  p = p || {};
  assert(cfgBool('ALLOW_EDIT'), 'ORDER_NOT_EDITABLE', 'ระบบไม่อนุญาตให้แก้ไข Order');
  var reqItems = normalizeOrderItems_(p.items);
  var note = sanitizeText(p.note, 200);
  var result = withLock(function () {
    var o = getOwnOrder_(user, p.order_id);
    if (o.status === ORDER_STATUS.CANCELLED) fail('ORDER_ALREADY_CANCELLED');
    if (o.status === ORDER_STATUS.PICKED_UP) fail('ORDER_ALREADY_PICKED_UP');
    assert(o.status === ORDER_STATUS.CONFIRMED, 'ORDER_NOT_EDITABLE', 'ครัวเริ่มเตรียมอาหารแล้ว ไม่สามารถแก้ไขได้');
    if (p.version !== undefined && toInt(p.version) !== toInt(o.version)) {
      fail('ORDER_NOT_EDITABLE', 'รายการนี้ถูกแก้ไขจากที่อื่นแล้ว กรุณาโหลดใหม่');
    }
    var w = getWindowById(o.window_id);
    var now = nowStr();
    assertWindowOrderable(w, now);
    var oldItems = getActiveOrderItems_(o);
    var released = {};
    oldItems.forEach(function (i) { released[i.daily_menu_id] = (released[i.daily_menu_id] || 0) + toInt(i.qty); });
    var checked = priceAndCheckItems_(w, reqItems, released);
    // Stock delta per daily menu row.
    var delta = {};
    Object.keys(released).forEach(function (id) { delta[id] = -released[id]; });
    checked.lines.forEach(function (l) { delta[l.d.daily_menu_id] = (delta[l.d.daily_menu_id] || 0) + l.qty; });
    var stockUpdates = [];
    Object.keys(delta).forEach(function (id) {
      if (!delta[id]) return;
      var d = checked.dmById[id];
      if (d) stockUpdates.push({ row: d, changes: { sold_qty: Math.max(0, toInt(d.sold_qty) + delta[id]), updated_at: now } });
    });
    dbUpdateMany('DAILY_MENU', stockUpdates);
    dbUpdateMany('ORDER_ITEMS', oldItems.map(function (i) { return { row: i, changes: { status: 'REMOVED' } }; }));
    dbInsertMany('ORDER_ITEMS', checked.lines.map(function (l) {
      return {
        order_item_id: uuid(), order_id: o.order_id, window_id: w.window_id, daily_menu_id: l.d.daily_menu_id,
        item_id: l.d.item_id, item_name_snapshot: l.d.item_name, qty: l.qty, unit_price: l.unit_price,
        subtotal: l.subtotal, item_note: l.note || '', status: 'ACTIVE', created_at: now, is_sample: 'FALSE'
      };
    }));
    var before = { qty: o.total_qty, amount: o.total_amount, items: parseOrderItems(o).map(function (i) { return i.name + ' x' + i.qty; }) };
    dbUpdate('ORDERS', o, {
      total_qty: checked.totalQty, total_amount: checked.totalAmount, items_json: itemsJson_(checked.lines),
      note: note, updated_at: now, version: toInt(o.version) + 1
    });
    var pay = dbFindOne('PAYMENT', 'order_id', o.order_id);
    if (pay) dbUpdate('PAYMENT', pay, { amount: checked.totalAmount, updated_at: now });
    dbInsert('ORDER_STATUS_LOG', statusLogRow_(o, o.status, o.status, user, 'แก้ไขรายการ'));
    return { order: o, window: w, before: before };
  });
  writeAudit(user, 'UPDATE_ORDER', 'ORDER', result.order.order_no, result.before,
    { qty: result.order.total_qty, amount: result.order.total_amount, items: parseOrderItems(result.order).map(function (i) { return i.name + ' x' + i.qty; }) });
  afterOrderCommitted_(result.order, 'EDIT');
  return { order: orderToClient(result.order, result.window) };
}

/**
 * Releases stock and voids payment for an order being cancelled (caller holds lock).
 */
function releaseOrderStock_(o, now) {
  var items = getActiveOrderItems_(o);
  if (!items.length) return;
  var dm = indexBy(dbFind('DAILY_MENU', 'window_id', o.window_id), 'daily_menu_id');
  var byId = {};
  items.forEach(function (i) { byId[i.daily_menu_id] = (byId[i.daily_menu_id] || 0) + toInt(i.qty); });
  var updates = [];
  Object.keys(byId).forEach(function (id) {
    if (dm[id]) updates.push({ row: dm[id], changes: { sold_qty: Math.max(0, toInt(dm[id].sold_qty) - byId[id]), updated_at: now } });
  });
  dbUpdateMany('DAILY_MENU', updates);
  var pay = dbFindOne('PAYMENT', 'order_id', o.order_id);
  if (pay) dbUpdate('PAYMENT', pay, { status: 'VOID', updated_at: now });
}

/**
 * Employee cancels own order (CONFIRMED, before cutoff, ALLOW_CANCEL).
 * @param {{order_id:string, reason?:string}} p
 */
function cancelOwnOrder(user, p) {
  p = p || {};
  assert(cfgBool('ALLOW_CANCEL'), 'INVALID_STATUS', 'ระบบไม่อนุญาตให้ยกเลิก Order');
  var result = withLock(function () {
    var o = getOwnOrder_(user, p.order_id);
    if (o.status === ORDER_STATUS.CANCELLED) fail('ORDER_ALREADY_CANCELLED');
    if (o.status === ORDER_STATUS.PICKED_UP) fail('ORDER_ALREADY_PICKED_UP');
    assert(o.status === ORDER_STATUS.CONFIRMED, 'INVALID_STATUS', 'ครัวเริ่มเตรียมอาหารแล้ว ไม่สามารถยกเลิกได้');
    var w = getWindowById(o.window_id);
    var now = nowStr();
    assertWindowOrderable(w, now);
    releaseOrderStock_(o, now);
    var from = o.status;
    dbUpdate('ORDERS', o, {
      status: ORDER_STATUS.CANCELLED, cancelled_at: now, cancelled_by: user.employee_code,
      updated_at: now, version: toInt(o.version) + 1
    });
    dbInsert('ORDER_STATUS_LOG', statusLogRow_(o, from, ORDER_STATUS.CANCELLED, user, p.reason || 'พนักงานยกเลิกเอง'));
    return { order: o, window: w };
  });
  writeAudit(user, 'CANCEL_ORDER', 'ORDER', result.order.order_no, 'CONFIRMED', 'CANCELLED');
  afterOrderCommitted_(result.order, 'CANCEL');
  return { order: orderToClient(result.order, result.window) };
}

/**
 * Kitchen/Admin status change with transition validation.
 * @param {{order_id:string, status:string, reason?:string, version?:number}} p
 */
function changeOrderStatus(user, p) {
  p = p || {};
  var to = String(p.status || '').toUpperCase();
  assert(ORDER_STATUS[to], 'INVALID_STATUS');
  var result = withLock(function () {
    var o = dbFindOne('ORDERS', 'order_id', String(p.order_id || ''));
    assert(o, 'ORDER_NOT_FOUND');
    return applyStatusChange_(user, o, to, p.reason, p.version);
  });
  writeAudit(user, 'ORDER_STATUS', 'ORDER', result.order.order_no, result.from, to);
  return { order: orderToClient(result.order, result.window) };
}

/**
 * Applies one status transition (caller holds lock).
 * @return {{order:Object, window:Object, from:string}}
 */
function applyStatusChange_(user, o, to, reason, version) {
  var from = o.status;
  if (from === to) {
    if (to === ORDER_STATUS.PICKED_UP) fail('ORDER_ALREADY_PICKED_UP', ERR.ORDER_ALREADY_PICKED_UP, { picked_up_at: o.picked_up_at, picked_up_by: o.picked_up_by });
    if (to === ORDER_STATUS.CANCELLED) fail('ORDER_ALREADY_CANCELLED');
    fail('INVALID_STATUS', 'สถานะเป็น ' + ORDER_STATUS_TH[to] + ' อยู่แล้ว');
  }
  if (from === ORDER_STATUS.CANCELLED) fail('ORDER_ALREADY_CANCELLED');
  if (version !== undefined && version !== null && version !== '' && toInt(version) !== toInt(o.version)) {
    fail('INVALID_STATUS', 'รายการนี้ถูกอัปเดตจากที่อื่นแล้ว กรุณาโหลดใหม่');
  }
  var table = ORDER_TRANSITIONS[user.role === ROLE.ADMIN ? 'ADMIN' : 'KITCHEN'];
  var allowed = table[from] || [];
  if (allowed.indexOf(to) < 0) {
    if (from === ORDER_STATUS.PICKED_UP) fail('ORDER_ALREADY_PICKED_UP');
    fail('INVALID_STATUS', 'ไม่สามารถเปลี่ยนจาก "' + ORDER_STATUS_TH[from] + '" เป็น "' + ORDER_STATUS_TH[to] + '"');
  }
  var now = nowStr();
  var w = dbFindOne('MEAL_WINDOWS', 'window_id', o.window_id);
  var changes = { status: to, updated_at: now, version: toInt(o.version) + 1 };
  if (to === ORDER_STATUS.CANCELLED) {
    releaseOrderStock_(o, now);
    changes.cancelled_at = now;
    changes.cancelled_by = user.employee_code;
  }
  if (to === ORDER_STATUS.PICKED_UP) {
    changes.picked_up_at = now;
    changes.picked_up_by = user.employee_code;
  }
  if (from === ORDER_STATUS.PICKED_UP) {
    changes.picked_up_at = '';
    changes.picked_up_by = '';
  }
  dbUpdate('ORDERS', o, changes);
  dbInsert('ORDER_STATUS_LOG', statusLogRow_(o, from, to, user, reason));
  return { order: o, window: w, from: from };
}

/**
 * Bulk status change for kitchen (e.g. all CONFIRMED -> PREPARING).
 * Invalid transitions are skipped and reported.
 * @param {{order_ids:string[], status:string}} p
 */
function bulkChangeOrderStatus(user, p) {
  p = p || {};
  var to = String(p.status || '').toUpperCase();
  assert(ORDER_STATUS[to] && to !== ORDER_STATUS.CANCELLED, 'INVALID_STATUS');
  var ids = Array.isArray(p.order_ids) ? p.order_ids.map(String).slice(0, 300) : [];
  assert(ids.length > 0, 'VALIDATION_ERROR', 'กรุณาเลือกรายการ');
  var res = withLock(function () {
    var ok = 0, skipped = [];
    ids.forEach(function (id) {
      var o = dbFindOne('ORDERS', 'order_id', id);
      if (!o) { skipped.push(id); return; }
      try { applyStatusChange_(user, o, to, 'Bulk update'); ok++; } catch (e) { skipped.push(o.order_no); }
    });
    return { updated: ok, skipped: skipped };
  });
  writeAudit(user, 'BULK_ORDER_STATUS', 'ORDER', '', '', { status: to, updated: res.updated, skipped: res.skipped.length });
  return res;
}

/**
 * Confirms food pickup. Prevents double pickup.
 * @param {{order_id:string}} p
 */
function pickupOrder(user, p) {
  p = p || {};
  var result = withLock(function () {
    var o = dbFindOne('ORDERS', 'order_id', String(p.order_id || ''));
    assert(o, 'ORDER_NOT_FOUND');
    if (o.status === ORDER_STATUS.PICKED_UP) {
      fail('ORDER_ALREADY_PICKED_UP', 'รับอาหารไปแล้วเมื่อ ' + hhmm(o.picked_up_at) + ' น. (โดย ' + o.picked_up_by + ')',
        { picked_up_at: o.picked_up_at, picked_up_by: o.picked_up_by });
    }
    if (o.status === ORDER_STATUS.CANCELLED) fail('ORDER_ALREADY_CANCELLED');
    return applyStatusChange_(user, o, ORDER_STATUS.PICKED_UP, 'รับอาหาร');
  });
  writeAudit(user, 'PICKUP_ORDER', 'ORDER', result.order.order_no, result.from, 'PICKED_UP');
  return { order: orderToClient(result.order, result.window) };
}

/**
 * Current user's orders.
 * @param {{tab:'today'|'history', limit?:number}} p
 */
function getMyOrders(user, p) {
  p = p || {};
  var tab = p.tab === 'history' ? 'history' : 'today';
  var limit = Math.min(100, Math.max(5, toInt(p.limit, 40)));
  var today = todayStr();
  var rows = dbFind('ORDERS', 'employee_id', user.employee_id, { last: tab === 'today' ? 10 : limit + 10 });
  rows = rows.filter(function (o) { return tab === 'today' ? o.order_date >= today : o.order_date < today; });
  rows.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  rows = rows.slice(0, limit);
  var winIds = {};
  rows.forEach(function (o) { winIds[o.window_id] = true; });
  var windows = {};
  if (rows.length) {
    dbAll('MEAL_WINDOWS').forEach(function (w) { if (winIds[w.window_id]) windows[w.window_id] = w; });
  }
  return { tab: tab, rows: rows.map(function (o) { return orderToClient(o, windows[o.window_id]); }) };
}

/** One order (owner, or KITCHEN/ADMIN/VIEWER). */
function getOrderDetail(user, p) {
  var o = dbFindOne('ORDERS', 'order_id', String(p && p.order_id || ''));
  assert(o, 'ORDER_NOT_FOUND');
  if (o.employee_id !== user.employee_id) requireRole(user, [ROLE.KITCHEN, ROLE.ADMIN, ROLE.VIEWER]);
  var w = dbFindOne('MEAL_WINDOWS', 'window_id', o.window_id);
  var out = orderToClient(o, w);
  out.history = stripInternal(dbFind('ORDER_STATUS_LOG', 'order_id', o.order_id));
  return { order: out };
}

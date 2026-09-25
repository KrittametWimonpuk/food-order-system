/**
 * KitchenService.gs
 * ---------------------------------------------------------------------------
 * Kitchen dashboard, order list, pickup lookup and final summary.
 */

/**
 * Resolves the windows to work on: explicit window_id, or all windows of a date
 * (default today) with the "current" one selected.
 * @return {{date:string, windows:Array, selected:Object|null, all:boolean}}
 */
function resolveKitchenWindow_(p) {
  p = p || {};
  var now = nowStr();
  if (p.window_id && p.window_id !== 'ALL') {
    var w = getWindowById(p.window_id);
    return { date: w.date, windows: getWindowsByDate(w.date), selected: w, all: false };
  }
  var date = p.date ? validateDateStr(p.date) : todayStr();
  if (date === todayStr()) {
    try { ensureWindowsForDate(date); } catch (e) { logError(e, 'KITCHEN', 'ensureWindowsForDate'); }
  }
  var windows = getWindowsByDate(date);
  return { date: date, windows: windows, selected: p.window_id === 'ALL' ? null : pickCurrentWindow(windows, now), all: p.window_id === 'ALL' };
}

/** Orders for the resolved scope. */
function scopeOrders_(scope) {
  if (scope.selected) return dbFind('ORDERS', 'window_id', scope.selected.window_id);
  var ids = {};
  scope.windows.forEach(function (w) { ids[w.window_id] = true; });
  return dbFind('ORDERS', 'order_date', scope.date).filter(function (o) { return ids[o.window_id]; });
}

/**
 * Kitchen dashboard: KPIs, per-menu counts (with stock), status + department breakdown.
 * @param {{window_id?:string, date?:string}} p
 */
function getKitchenDashboard(user, p) {
  var scope = resolveKitchenWindow_(p);
  var now = nowStr();
  var orders = scopeOrders_(scope);
  var agg = aggregateOrders(orders);
  var stock = [];
  if (scope.selected) {
    var master = indexBy(getMenuMaster(), 'item_id');
    stock = getDailyMenuRows(scope.selected.window_id).map(function (d) { return dailyMenuToClient(d, master); });
  }
  var recent = orders.slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 8)
    .map(function (o) { return orderToClient(o, scope.selected); });
  return {
    date: scope.date,
    date_th: thaiDate(scope.date),
    windows: scope.windows.map(function (w) { return windowToClient(w, now); }),
    window: scope.selected ? windowToClient(scope.selected, now) : null,
    kpi: agg.kpi,
    byMenu: agg.byMenu,
    byDepartment: agg.byDepartment,
    byStatus: agg.byStatus,
    stock: stock,
    recent: recent,
    serverTime: now
  };
}

/**
 * Kitchen / admin order list with filters, search and paging.
 * @param {{window_id?, date?, status?, department?, item_id?, q?, page?, pageSize?}} p
 */
function listKitchenOrders(user, p) {
  p = p || {};
  var scope = resolveKitchenWindow_(p);
  var now = nowStr();
  var orders = scopeOrders_(scope);
  var windowsById = indexBy(scope.windows, 'window_id');
  var statusCounts = { ALL: 0 };
  var departments = {}, menus = {};
  orders.forEach(function (o) {
    statusCounts.ALL++;
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    if (o.department) departments[o.department] = true;
    parseOrderItems(o).forEach(function (i) { menus[i.item_id] = i.name; });
  });
  var status = String(p.status || '').toUpperCase();
  var q = String(p.q || '').trim().toLowerCase();
  var filtered = orders.filter(function (o) {
    if (status && status !== 'ALL' && o.status !== status) return false;
    if (p.department && o.department !== p.department) return false;
    var items = parseOrderItems(o);
    if (p.item_id && !items.some(function (i) { return i.item_id === p.item_id; })) return false;
    if (q) {
      var hay = [o.order_no, o.employee_code, o.employee_name, o.department, o.note]
        .concat(items.map(function (i) { return i.name; })).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  var sortDir = p.sort === 'desc' ? -1 : 1;
  filtered.sort(function (a, b) { return (a.created_at < b.created_at ? -1 : 1) * sortDir; });
  var pageSize = Math.min(200, Math.max(10, toInt(p.pageSize, 50)));
  var totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  var page = Math.min(totalPages, Math.max(1, toInt(p.page, 1)));
  var slice = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    date: scope.date,
    windows: scope.windows.map(function (w) { return windowToClient(w, now); }),
    window: scope.selected ? windowToClient(scope.selected, now) : null,
    rows: slice.map(function (o, i) {
      var c = orderToClient(o, windowsById[o.window_id]);
      c.seq = (page - 1) * pageSize + i + 1;
      return c;
    }),
    total: filtered.length,
    page: page,
    pageSize: pageSize,
    totalPages: totalPages,
    statusCounts: statusCounts,
    departments: Object.keys(departments).sort(),
    menus: Object.keys(menus).map(function (id) { return { item_id: id, name: menus[id] }; })
  };
}

/**
 * Pickup lookup by order number (ORD-...) or employee code (today's windows).
 * @param {{q:string}} p
 */
function lookupPickup(user, p) {
  var q = String(p && p.q || '').trim().toUpperCase();
  assert(q.length >= 2 && q.length <= 40 && /^[A-Z0-9_\-]+$/.test(q), 'VALIDATION_ERROR', 'กรุณากรอกรหัสพนักงานหรือเลข Order');
  var now = nowStr();
  var orders;
  if (/^ORD-\d{6}-\d{3,}$/.test(q)) {
    var o = dbFindOne('ORDERS', 'order_no', q);
    orders = o ? [o] : [];
  } else {
    var today = todayStr();
    orders = dbFind('ORDERS', 'employee_code', q, { last: 20 }).filter(function (o) { return o.order_date === today; });
  }
  var windows = {};
  orders.forEach(function (o) { if (!windows[o.window_id]) windows[o.window_id] = dbFindOne('MEAL_WINDOWS', 'window_id', o.window_id); });
  var rows = orders.sort(function (a, b) {
    var rank = function (s) { return s === 'CANCELLED' ? 2 : (s === 'PICKED_UP' ? 1 : 0); };
    return rank(a.status) - rank(b.status) || (a.created_at < b.created_at ? 1 : -1);
  }).map(function (o) { return orderToClient(o, windows[o.window_id]); });
  var employee = null;
  if (!rows.length && !/^ORD-/.test(q)) {
    var emp = dbFindOne('EMPLOYEES', 'employee_code', q);
    if (emp) employee = publicEmployee(emp, true);
  }
  return { q: q, rows: rows, employee: employee, serverTime: now };
}

/**
 * Final summary for a window (kitchen prep sheet): per menu, per department x menu.
 * @param {{window_id?:string, date?:string}} p
 */
function getFinalSummary(user, p) {
  var scope = resolveKitchenWindow_(p);
  var orders = scopeOrders_(scope).filter(function (o) { return o.status !== ORDER_STATUS.CANCELLED; });
  var agg = aggregateOrders(orders);
  var matrix = {};
  var notes = [];
  orders.forEach(function (o) {
    var dept = o.department || '-';
    var row = matrix[dept] = matrix[dept] || {};
    parseOrderItems(o).forEach(function (i) {
      row[i.name] = (row[i.name] || 0) + i.qty;
      if (i.note) notes.push({ order_no: o.order_no, employee_name: o.employee_name, name: i.name, qty: i.qty, note: i.note });
    });
    if (o.note) notes.push({ order_no: o.order_no, employee_name: o.employee_name, name: '(หมายเหตุ Order)', qty: '', note: o.note });
  });
  return {
    date: scope.date,
    date_th: thaiDate(scope.date),
    windows: scope.windows.map(function (w) { return windowToClient(w); }),
    window: scope.selected ? windowToClient(scope.selected) : null,
    kpi: agg.kpi,
    byMenu: agg.byMenu,
    byDepartment: agg.byDepartment,
    matrix: matrix,
    menuNames: agg.byMenu.map(function (m) { return m.name; }),
    notes: notes,
    generatedAt: nowStr()
  };
}

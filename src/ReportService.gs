/**
 * ReportService.gs
 * ---------------------------------------------------------------------------
 * Aggregations for dashboards and reports, CSV export and daily summary.
 * Reports are a secondary service: failures here never affect ordering.
 */

var REVENUE_STATUSES = ['CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP', 'NO_SHOW'];
var ORDER_DATE_MARGIN_DAYS = 7;

/**
 * Reads orders whose order_date is within [from, to].
 * Orders are appended chronologically, so the sheet is scanned backwards in
 * chunks and scanning stops once rows are older than `from` minus a margin.
 * @return {Array<Object>}
 */
function getOrdersByDateRange(from, to) {
  var sh = getTableSheet('ORDERS');
  var lastRow = sh.getLastRow();
  var stopBefore = addDays(from, -ORDER_DATE_MARGIN_DAYS) + ' 00:00:00';
  var chunk = 2500;
  var out = [];
  var end = lastRow;
  while (end >= 2) {
    var start = Math.max(2, end - chunk + 1);
    var block = dbReadBlock_('ORDERS', start, end);
    var minCreated = '9999';
    block.forEach(function (o) {
      if (o.created_at && o.created_at < minCreated) minCreated = o.created_at;
      if (o.order_date >= from && o.order_date <= to) out.push(o);
    });
    if (minCreated < stopBefore) break;
    end = start - 1;
  }
  out.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
  return out;
}

/**
 * Aggregates orders into KPIs and breakdowns.
 * @param {Array<Object>} orders
 */
function aggregateOrders(orders) {
  var k = { orders: 0, qty: 0, revenue: 0, cancelled: 0, cancelled_qty: 0, no_show: 0, picked_up: 0,
    pending: 0, preparing: 0, ready: 0, confirmed: 0, all_orders: orders.length };
  var byMenu = {}, byDept = {}, byDate = {}, byEmp = {}, byStatus = {};
  orders.forEach(function (o) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    var date = o.order_date;
    var t = byDate[date] = byDate[date] || { date: date, orders: 0, qty: 0, revenue: 0, cancelled: 0, no_show: 0 };
    var e = byEmp[o.employee_id] = byEmp[o.employee_id] || {
      employee_code: o.employee_code, name: o.employee_name, department: o.department,
      orders: 0, qty: 0, revenue: 0, cancelled: 0, no_show: 0
    };
    if (o.status === ORDER_STATUS.CANCELLED) {
      k.cancelled++; k.cancelled_qty += toInt(o.total_qty); t.cancelled++; e.cancelled++;
      return;
    }
    var qty = toInt(o.total_qty), amt = toNum(o.total_amount);
    k.orders++; k.qty += qty; k.revenue = roundMoney(k.revenue + amt);
    t.orders++; t.qty += qty; t.revenue = roundMoney(t.revenue + amt);
    e.orders++; e.qty += qty; e.revenue = roundMoney(e.revenue + amt);
    if (o.status === ORDER_STATUS.NO_SHOW) { k.no_show++; t.no_show++; e.no_show++; }
    if (o.status === ORDER_STATUS.PICKED_UP) k.picked_up++;
    if (o.status === ORDER_STATUS.CONFIRMED) k.confirmed++;
    if (o.status === ORDER_STATUS.PREPARING) k.preparing++;
    if (o.status === ORDER_STATUS.READY) k.ready++;
    var d = byDept[o.department || '-'] = byDept[o.department || '-'] || { department: o.department || '-', orders: 0, qty: 0, revenue: 0 };
    d.orders++; d.qty += qty; d.revenue = roundMoney(d.revenue + amt);
    parseOrderItems(o).forEach(function (it) {
      var key = it.item_id || it.name;
      var m = byMenu[key] = byMenu[key] || { item_id: it.item_id, name: it.name, qty: 0, revenue: 0, orders: 0 };
      m.qty += it.qty; m.revenue = roundMoney(m.revenue + it.subtotal); m.orders++;
    });
  });
  k.pending = k.orders - k.picked_up - k.no_show;
  var sortDesc = function (key) { return function (a, b) { return b[key] - a[key]; }; };
  return {
    kpi: k,
    byMenu: Object.keys(byMenu).map(function (x) { return byMenu[x]; }).sort(sortDesc('qty')),
    byDepartment: Object.keys(byDept).map(function (x) { return byDept[x]; }).sort(sortDesc('qty')),
    byDate: Object.keys(byDate).sort().map(function (x) { return byDate[x]; }),
    byEmployee: Object.keys(byEmp).map(function (x) { return byEmp[x]; }).sort(sortDesc('qty')),
    byStatus: byStatus
  };
}

/** Validates report filters and returns normalised values. */
function reportFilters_(p) {
  p = p || {};
  var today = todayStr();
  var from = p.from ? validateDateStr(p.from) : today;
  var to = p.to ? validateDateStr(p.to) : today;
  if (from > to) { var t = from; from = to; to = t; }
  assert(diffMs(from, to) <= 400 * 86400000, 'VALIDATION_ERROR', 'ช่วงวันที่ต้องไม่เกิน 400 วัน');
  var meal = String(p.meal || '').toUpperCase();
  if (meal && MEAL_TYPES.indexOf(meal) < 0) meal = '';
  return { from: from, to: to, meal: meal, department: sanitizeText(p.department, 50) };
}

/** Orders filtered by report filters. */
function reportOrders_(f) {
  return getOrdersByDateRange(f.from, f.to).filter(function (o) {
    if (f.meal && o.meal !== f.meal) return false;
    if (f.department && o.department !== f.department) return false;
    return true;
  });
}

/**
 * Report dashboard data.
 * @param {{from:string, to:string, meal:string, department:string}} p
 */
function getReport(user, p) {
  var f = reportFilters_(p);
  var orders = reportOrders_(f);
  var agg = aggregateOrders(orders);
  var cancellations = orders.filter(function (o) { return o.status === ORDER_STATUS.CANCELLED; }).slice(-100).reverse()
    .map(function (o) { return { order_no: o.order_no, employee_code: o.employee_code, employee_name: o.employee_name, department: o.department, order_date: o.order_date, meal: o.meal, total_qty: toInt(o.total_qty), total_amount: toNum(o.total_amount), cancelled_at: o.cancelled_at, cancelled_by: o.cancelled_by }; });
  var noShows = orders.filter(function (o) { return o.status === ORDER_STATUS.NO_SHOW; }).slice(-100).reverse()
    .map(function (o) { return { order_no: o.order_no, employee_code: o.employee_code, employee_name: o.employee_name, department: o.department, order_date: o.order_date, meal: o.meal, total_qty: toInt(o.total_qty), total_amount: toNum(o.total_amount) }; });
  return {
    filters: f,
    kpi: agg.kpi,
    byMenu: agg.byMenu,
    byDepartment: agg.byDepartment,
    byDate: fillDateGaps_(agg.byDate, f.from, f.to),
    byEmployee: agg.byEmployee.slice(0, 100),
    byStatus: agg.byStatus,
    cancellations: cancellations,
    noShows: noShows,
    departments: cfgList('DEPARTMENTS')
  };
}

/** Adds zero rows for missing dates (max 400). */
function fillDateGaps_(rows, from, to) {
  var map = indexBy(rows, 'date');
  var out = [];
  var d = from;
  for (var i = 0; i < 400 && d <= to; i++) {
    out.push(map[d] || { date: d, orders: 0, qty: 0, revenue: 0, cancelled: 0, no_show: 0 });
    d = addDays(d, 1);
  }
  return out;
}

/**
 * Builds a CSV export.
 * @param {{type:string, from, to, meal, department}} p
 * @return {{filename:string, csv:string, mimeType:string, rows:number}}
 */
function exportReportCsv(user, p) {
  p = p || {};
  var f = reportFilters_(p);
  var type = String(p.type || 'orders');
  var orders = reportOrders_(f);
  var header, rows;
  if (type === 'orders') {
    header = ['order_no', 'date', 'meal', 'created_at', 'employee_code', 'employee_name', 'department', 'items',
      'total_qty', 'total_amount', 'status', 'note', 'picked_up_at', 'picked_up_by', 'cancelled_at'];
    rows = orders.map(function (o) {
      return [o.order_no, o.order_date, o.meal, o.created_at, o.employee_code, o.employee_name, o.department,
        parseOrderItems(o).map(function (i) { return i.name + ' x' + i.qty; }).join(' | '),
        toInt(o.total_qty), toNum(o.total_amount), ORDER_STATUS_TH[o.status] || o.status, o.note,
        o.picked_up_at, o.picked_up_by, o.cancelled_at];
    });
  } else {
    var agg = aggregateOrders(orders);
    if (type === 'menu') {
      header = ['menu', 'qty', 'orders', 'revenue'];
      rows = agg.byMenu.map(function (m) { return [m.name, m.qty, m.orders, m.revenue]; });
    } else if (type === 'department') {
      header = ['department', 'orders', 'qty', 'revenue'];
      rows = agg.byDepartment.map(function (d) { return [d.department, d.orders, d.qty, d.revenue]; });
    } else if (type === 'employee') {
      header = ['employee_code', 'name', 'department', 'orders', 'qty', 'revenue', 'cancelled', 'no_show'];
      rows = agg.byEmployee.map(function (e) { return [e.employee_code, e.name, e.department, e.orders, e.qty, e.revenue, e.cancelled, e.no_show]; });
    } else {
      type = 'daily';
      header = ['date', 'orders', 'qty', 'revenue', 'cancelled', 'no_show'];
      rows = fillDateGaps_(agg.byDate, f.from, f.to).map(function (d) { return [d.date, d.orders, d.qty, d.revenue, d.cancelled, d.no_show]; });
    }
  }
  var csv = '﻿' + [header].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  writeAudit(user, 'EXPORT_REPORT', 'REPORT', type, '', { from: f.from, to: f.to, rows: rows.length });
  return {
    filename: 'report_' + type + '_' + f.from + '_' + f.to + '.csv',
    csv: csv, mimeType: 'text/csv;charset=utf-8', rows: rows.length
  };
}

/** Saves the CSV export to Drive and returns its URL (fallback for blocked downloads). */
function exportReportToDrive(user, p) {
  var res = exportReportCsv(user, p);
  var folder = getOrCreateFolderByProp_(PROP.EXPORT_FOLDER_ID, 'FoodFactory-Exports');
  var file = folder.createFile(Utilities.newBlob(res.csv, 'text/csv', res.filename));
  return { url: file.getUrl(), filename: res.filename, rows: res.rows };
}

/**
 * Upserts 13_DAILY_SUMMARY for a window.
 * @param {string} windowId
 */
function upsertDailySummary(windowId) {
  var w = getWindowById(windowId);
  var agg = aggregateOrders(dbFind('ORDERS', 'window_id', windowId));
  var k = agg.kpi;
  var now = nowStr();
  var existing = dbFindOne('DAILY_SUMMARY', 'window_id', windowId);
  var data = {
    date: w.date, meal: w.meal, window_id: windowId, total_orders: k.orders, total_qty: k.qty,
    total_amount: k.revenue, cancelled: k.cancelled, picked_up: k.picked_up, no_show: k.no_show, updated_at: now
  };
  if (existing) dbUpdate('DAILY_SUMMARY', existing, data);
  else {
    data.summary_id = uuid();
    data.created_at = now;
    dbInsert('DAILY_SUMMARY', data);
  }
  return data;
}

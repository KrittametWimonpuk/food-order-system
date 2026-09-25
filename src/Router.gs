/**
 * Router.gs
 * ---------------------------------------------------------------------------
 * Single RPC entry point for the web client:
 *     google.script.run.api(action, payload, token)
 *
 * For every call the router:
 *   1. assigns a requestId
 *   2. validates the action + payload
 *   3. validates the session token (unless the route is public) and loads the
 *      CURRENT role from the employee record (the client never supplies role)
 *   4. checks RBAC for the route
 *   5. runs the handler and wraps the result in the standard response format:
 *        { success: true,  data: {}, message: '', requestId: '' }
 *        { success: false, error: { code, message, details }, requestId: '' }
 */

var ROUTES_CACHE = null;

/**
 * Route table: action -> { roles, fn(user, payload, ctx), public?, allowPinChange? }
 * Built lazily because Apps Script evaluates files in order, so top-level
 * references to functions/constants of other files are not safe.
 */
function getRoutes_() {
  if (ROUTES_CACHE) return ROUTES_CACHE;
  var R_ANY = ALL_ROLES;
  var R_KA = [ROLE.KITCHEN, ROLE.ADMIN];
  var R_KAV = [ROLE.KITCHEN, ROLE.ADMIN, ROLE.VIEWER];
  var R_AV = [ROLE.ADMIN, ROLE.VIEWER];
  var R_A = [ROLE.ADMIN];
  ROUTES_CACHE = {
    // Public
    'app.info': { public: true, fn: function () { return getPublicAppInfo(); } },
    'auth.login': { public: true, fn: function (u, p) { return authLogin(p); } },
    'auth.forgotPin': { public: true, fn: function (u, p) { return authForgotPin(p); } },
    // Session
    'auth.me': { roles: R_ANY, allowPinChange: true, fn: authMe },
    'auth.logout': { roles: R_ANY, allowPinChange: true, fn: authLogout },
    'auth.changePin': { roles: R_ANY, allowPinChange: true, fn: authChangePin },
    // Employee app
    'employee.home': { roles: R_ANY, fn: getEmployeeHome },
    'order.create': { roles: R_ANY, fn: createOrder },
    'order.update': { roles: R_ANY, fn: updateOrder },
    'order.cancel': { roles: R_ANY, fn: cancelOwnOrder },
    'order.mine': { roles: R_ANY, fn: getMyOrders },
    'order.get': { roles: R_ANY, fn: getOrderDetail },
    // Kitchen
    'kitchen.dashboard': { roles: R_KAV, fn: getKitchenDashboard },
    'kitchen.orders': { roles: R_KAV, fn: listKitchenOrders },
    'kitchen.setStatus': { roles: R_KA, fn: changeOrderStatus },
    'kitchen.bulkStatus': { roles: R_KA, fn: bulkChangeOrderStatus },
    'kitchen.lookup': { roles: R_KA, fn: lookupPickup },
    'kitchen.pickup': { roles: R_KA, fn: pickupOrder },
    'kitchen.summary': { roles: R_KAV, fn: getFinalSummary },
    'kitchen.sendSummary': { roles: R_KA, fn: sendSummaryNow },
    // Admin / viewer dashboard + reports
    'admin.dashboard': { roles: R_AV, fn: getAdminDashboard },
    'report.get': { roles: R_KAV, fn: getReport },
    'report.export': { roles: R_KAV, fn: exportReportCsv },
    'report.exportDrive': { roles: R_KAV, fn: exportReportToDrive },
    // Menu master
    'menu.list': { roles: R_KA, fn: listMenuItems },
    'menu.save': { roles: R_A, fn: saveMenuItem },
    'menu.toggle': { roles: R_A, fn: toggleMenuItem },
    'menu.delete': { roles: R_A, fn: deleteMenuItem },
    'menu.restore': { roles: R_A, fn: restoreMenuItem },
    'menu.upload': { roles: R_A, fn: uploadMenuImage },
    // Daily menu
    'daily.list': { roles: R_KA, fn: listDailyMenu },
    'daily.add': { roles: R_A, fn: addDailyMenuItems },
    'daily.save': { roles: R_KA, fn: saveDailyMenu },
    'daily.remove': { roles: R_A, fn: removeDailyMenu },
    'daily.copy': { roles: R_A, fn: copyDefaultsToDailyMenu },
    'daily.recalc': { roles: R_A, fn: recalcDailyStock },
    // Meal windows
    'meal.list': { roles: R_KA, fn: listWindows },
    'meal.save': { roles: R_A, fn: saveWindow },
    'meal.setStatus': { roles: R_A, fn: setWindowStatus },
    'meal.setAuto': { roles: R_A, fn: setWindowAuto },
    // Employees
    'emp.list': { roles: R_A, fn: listEmployees },
    'emp.save': { roles: R_A, fn: saveEmployee },
    'emp.setStatus': { roles: R_A, fn: setEmployeeStatus },
    'emp.resetPin': { roles: R_A, fn: resetEmployeePin },
    'emp.import': { roles: R_A, fn: importEmployeesCsv },
    // Settings / system
    'settings.get': { roles: R_A, fn: getSettings },
    'settings.save': { roles: R_A, fn: saveSettings },
    'sample.clear': { roles: R_A, fn: clearSampleData },
    'trigger.status': { roles: R_A, fn: getTriggerStatus },
    'trigger.install': { roles: R_A, fn: installTriggers },
    // LINE / notifications
    'line.status': { roles: R_A, fn: getLineStatus },
    'line.test': { roles: R_A, fn: testLineNotification },
    'noti.list': { roles: R_A, fn: listNotifications },
    'noti.retry': { roles: R_A, fn: retryNotification },
    // Logs
    'log.audit': { roles: R_A, fn: listAuditLog },
    'log.error': { roles: R_A, fn: listErrorLog },
    'log.system': { roles: R_A, fn: listSystemLog },
    // Backup
    'backup.list': { roles: R_A, fn: listBackups },
    'backup.run': { roles: R_A, fn: backupNow }
  };
  return ROUTES_CACHE;
}

/** Error codes that are expected business outcomes (not logged to ERROR_LOG). */
var EXPECTED_ERRORS = {
  AUTH_INVALID: 1, AUTH_LOCKED: 1, AUTH_RATE_LIMIT: 1, EMPLOYEE_DISABLED: 1, PIN_CHANGE_REQUIRED: 1,
  SESSION_EXPIRED: 1, VALIDATION_ERROR: 1, NOT_FOUND: 1, MEAL_NOT_FOUND: 1, MEAL_NOT_OPEN: 1, MEAL_CLOSED: 1,
  MENU_NOT_FOUND: 1, MENU_SOLD_OUT: 1, INVALID_QTY: 1, INVALID_STATUS: 1, ORDER_NOT_FOUND: 1, ORDER_EXISTS: 1,
  ORDER_ALREADY_CANCELLED: 1, ORDER_ALREADY_PICKED_UP: 1, ORDER_NOT_EDITABLE: 1, DUPLICATE_REQUEST: 1,
  DUPLICATE_CODE: 1, PRICE_CHANGED: 1, LINE_NOT_CONFIGURED: 1, UNKNOWN_ACTION: 1
};

/**
 * Public RPC function called by the client via google.script.run.
 * @param {string} action e.g. "order.create"
 * @param {Object} payload
 * @param {string} token session token (null for public routes)
 * @return {Object} standard response
 */
function api(action, payload, token) {
  var requestId = newRequestId();
  REQUEST_CTX.requestId = requestId;
  REQUEST_CTX.user = null;
  var user = null;
  try {
    var name = validateActionName(action);
    var routes = getRoutes_();
    var route = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null;
    if (!route) fail('UNKNOWN_ACTION');
    var p = validatePayload(payload);
    var ctx = { token: typeof token === 'string' ? token : '', requestId: requestId };
    if (!route.public) {
      user = validateSession(ctx.token);
      REQUEST_CTX.user = user;
      if (user.must_change_pin && !route.allowPinChange) fail('PIN_CHANGE_REQUIRED');
      requireRole(user, route.roles);
    }
    var data = route.fn(user, p, ctx);
    return { success: true, data: data === undefined ? {} : data, message: '', requestId: requestId };
  } catch (e) {
    return errorResponse_(e, action, user, requestId);
  }
}

/** Builds an error response and logs unexpected errors. */
function errorResponse_(e, action, user, requestId) {
  var isApp = e && e.name === 'AppError';
  var code = isApp ? e.code : 'INTERNAL_ERROR';
  var message = isApp ? e.message : ERR.INTERNAL_ERROR;
  if (!isApp || !EXPECTED_ERRORS[code]) {
    logError(e, String(action || '').split('.')[0].toUpperCase(), String(action || ''), user ? user.employee_id : '');
  }
  if (!isApp) console.error('[' + requestId + '] ' + action + ': ' + (e && e.stack ? e.stack : e));
  return {
    success: false,
    error: { code: code, message: message, details: isApp ? e.details : null },
    requestId: requestId
  };
}

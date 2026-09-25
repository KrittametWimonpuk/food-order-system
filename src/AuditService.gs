/**
 * AuditService.gs
 * ---------------------------------------------------------------------------
 * Audit log, error log and system log writers + readers.
 * Logging must never break a business transaction, so writers swallow errors.
 */

/** Per-execution request context (set by Router). */
var REQUEST_CTX = { requestId: '', user: null };

/**
 * Writes an audit record.
 * @param {Object} user current user (employee_id, employee_code, role)
 * @param {string} action e.g. UPDATE_MENU
 * @param {string} module e.g. MENU
 * @param {string} targetId
 * @param {*} oldValue
 * @param {*} newValue
 */
function writeAudit(user, action, module, targetId, oldValue, newValue) {
  try {
    dbInsert('AUDIT_LOG', {
      audit_id: uuid(),
      timestamp: nowStr(),
      user_id: user ? user.employee_id : 'SYSTEM',
      user_code: user ? (user.employee_code || '') : 'SYSTEM',
      role: user ? (user.role || '') : 'SYSTEM',
      action: action,
      module: module,
      target_id: targetId || '',
      old_value: toLogString(oldValue, 3000),
      new_value: toLogString(newValue, 3000),
      request_id: REQUEST_CTX.requestId || ''
    });
  } catch (e) {
    console.error('writeAudit failed: ' + e);
  }
}

/** Returns the changed fields between two objects as {old, new}. */
function diffFields(before, after, keys) {
  var o = {}, n = {};
  keys.forEach(function (k) {
    if (after[k] !== undefined && String(before[k]) !== String(after[k])) {
      o[k] = before[k];
      n[k] = after[k];
    }
  });
  return { old: o, new: n, changed: Object.keys(n).length > 0 };
}

/**
 * Writes an error log entry.
 * @param {Error|AppError} err
 * @param {string} module
 * @param {string} functionName
 * @param {string=} userId
 */
function logError(err, module, functionName, userId) {
  try {
    dbInsert('ERROR_LOG', {
      error_id: uuid(),
      timestamp: nowStr(),
      request_id: REQUEST_CTX.requestId || '',
      module: module || '',
      function_name: functionName || '',
      user_id: userId || (REQUEST_CTX.user ? REQUEST_CTX.user.employee_id : ''),
      error_code: (err && err.code) || 'INTERNAL_ERROR',
      error_message: toLogString(err && err.message ? err.message : String(err), 1000),
      stack: toLogString(err && err.stack ? err.stack : '', 3000)
    });
  } catch (e) {
    console.error('logError failed: ' + e + ' original: ' + err);
  }
}

/**
 * Writes a system log entry.
 * @param {string} level INFO|WARN|ERROR
 */
function systemLog(level, module, event, message, data) {
  try {
    dbInsert('SYSTEM_LOG', {
      log_id: uuid(),
      timestamp: nowStr(),
      level: level || 'INFO',
      module: module || '',
      event: event || '',
      message: toLogString(message, 1000),
      data: toLogString(data, 3000)
    });
  } catch (e) {
    console.error('systemLog failed: ' + e);
  }
}

/**
 * Reads a log table newest-first with simple filtering and paging.
 * Only the tail of the sheet is read (logs are append-only).
 * @param {string} tableKey AUDIT_LOG|ERROR_LOG|SYSTEM_LOG
 * @param {{q:string, module:string, page:number, pageSize:number, date:string}} p
 */
function readLogTable_(tableKey, p) {
  p = p || {};
  var sh = getTableSheet(tableKey);
  var lastRow = sh.getLastRow();
  var maxScan = 3000;
  var rows = lastRow > 1 ? dbReadBlock_(tableKey, Math.max(2, lastRow - maxScan + 1), lastRow) : [];
  rows.reverse();
  var q = String(p.q || '').trim().toLowerCase();
  var mod = String(p.module || '').trim().toUpperCase();
  var date = String(p.date || '').trim();
  if (q || mod || date) {
    rows = rows.filter(function (r) {
      if (mod && String(r.module).toUpperCase() !== mod) return false;
      if (date && String(r.timestamp).substring(0, 10) !== date) return false;
      if (!q) return true;
      return Object.keys(r).some(function (k) { return String(r[k]).toLowerCase().indexOf(q) >= 0; });
    });
  }
  var pageSize = Math.min(200, Math.max(10, toInt(p.pageSize, 50)));
  var page = Math.max(1, toInt(p.page, 1));
  var total = rows.length;
  return {
    rows: stripInternal(rows.slice((page - 1) * pageSize, page * pageSize)),
    total: total,
    page: page,
    pageSize: pageSize,
    scanned: Math.min(maxScan, Math.max(0, lastRow - 1))
  };
}

function listAuditLog(user, p) { return readLogTable_('AUDIT_LOG', p); }
function listErrorLog(user, p) { return readLogTable_('ERROR_LOG', p); }
function listSystemLog(user, p) { return readLogTable_('SYSTEM_LOG', p); }

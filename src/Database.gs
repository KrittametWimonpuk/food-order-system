/**
 * Database.gs
 * ---------------------------------------------------------------------------
 * Thin data-access layer over Google Sheets.
 *  - Each logical table (see SCHEMA) maps to one sheet with a header row.
 *  - Columns are resolved by header name, so manual column re-ordering is safe.
 *  - Reads are batched (one getValues per table per execution) and memoised.
 *  - Targeted lookups use TextFinder so large tables are not read fully.
 *  - Writes are batched with setValues; text columns are forced to '@' format so
 *    IDs, dates and times are never auto-converted by Sheets.
 */

var DB_STATE = { ss: null, sheets: {}, headers: {}, memo: {} };

/** Money columns get a 2-decimal format; other numeric columns get integer format. */
var MONEY_COLUMNS = { default_price: 1, price: 1, total_amount: 1, unit_price: 1, subtotal: 1, amount: 1 };

/**
 * Returns the database spreadsheet.
 * Uses Script Property DATABASE_SHEET_ID, or the bound spreadsheet as fallback.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getDatabase() {
  if (DB_STATE.ss) return DB_STATE.ss;
  var id = getScriptProp(PROP.DATABASE_SHEET_ID);
  var ss = null;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    if (ss) setScriptProp(PROP.DATABASE_SHEET_ID, ss.getId());
  }
  if (!ss) fail('SETUP_REQUIRED', 'ยังไม่ได้ตั้งค่า DATABASE_SHEET_ID ใน Script Properties');
  DB_STATE.ss = ss;
  return ss;
}

/** Returns the sheet for a table key, throwing SETUP_REQUIRED when missing. */
function getTableSheet(tableKey) {
  if (DB_STATE.sheets[tableKey]) return DB_STATE.sheets[tableKey];
  var def = SCHEMA[tableKey];
  if (!def) fail('DB_ERROR', 'Unknown table ' + tableKey);
  var sh = getDatabase().getSheetByName(def.name);
  if (!sh) fail('SETUP_REQUIRED', 'ไม่พบชีต ' + def.name + ' กรุณารัน setupDatabase()');
  DB_STATE.sheets[tableKey] = sh;
  return sh;
}

/** Returns {names:[], index:{name:colIdx0}} for the table header. */
function getTableHeader(tableKey) {
  if (DB_STATE.headers[tableKey]) return DB_STATE.headers[tableKey];
  var sh = getTableSheet(tableKey);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var names = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var index = {};
  names.forEach(function (n, i) { if (n) index[n] = i; });
  var header = { names: names, index: index, width: lastCol };
  DB_STATE.headers[tableKey] = header;
  return header;
}

/** Converts a raw row array into an object keyed by schema column. */
function rowToObject_(tableKey, header, values, rowNumber) {
  var def = SCHEMA[tableKey];
  var obj = { _row: rowNumber };
  def.columns.forEach(function (col) {
    var i = header.index[col];
    var v = i === undefined ? '' : values[i];
    if (def.numeric.indexOf(col) >= 0) obj[col] = toNum(v, 0);
    else obj[col] = cellToString(v);
  });
  return obj;
}

/** Converts an object into a row array following the sheet header. */
function objectToRow_(tableKey, header, obj, existing) {
  var def = SCHEMA[tableKey];
  var row = existing ? existing.slice() : new Array(header.width).fill('');
  def.columns.forEach(function (col) {
    var i = header.index[col];
    if (i === undefined || !(col in obj)) return;
    var v = obj[col];
    if (def.numeric.indexOf(col) >= 0) row[i] = toNum(v, 0);
    else {
      var s = v === null || v === undefined ? '' : (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
      // A leading apostrophe forces Sheets to keep "=..." as text (never a formula).
      row[i] = s.charAt(0) === '=' ? "'" + s : s;
    }
  });
  return row;
}

/** Number formats for one row following the header. */
function rowFormats_(tableKey, header) {
  var def = SCHEMA[tableKey];
  return header.names.map(function (name) {
    if (def.numeric.indexOf(name) >= 0) return MONEY_COLUMNS[name] ? '#,##0.00' : '0';
    return '@';
  });
}

/**
 * Reads all rows of a table (memoised per execution).
 * @param {string} tableKey
 * @return {Array<Object>}
 */
function dbAll(tableKey) {
  if (DB_STATE.memo[tableKey]) return DB_STATE.memo[tableKey];
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  var lastRow = sh.getLastRow();
  var rows = [];
  if (lastRow > 1) {
    var values = sh.getRange(2, 1, lastRow - 1, header.width).getValues();
    for (var r = 0; r < values.length; r++) {
      if (values[r].join('') === '') continue;
      rows.push(rowToObject_(tableKey, header, values[r], r + 2));
    }
  }
  DB_STATE.memo[tableKey] = rows;
  return rows;
}

/** Reads a contiguous block of rows (1-based sheet row numbers). */
function dbReadBlock_(tableKey, startRow, endRow) {
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  if (endRow < startRow) return [];
  var values = sh.getRange(startRow, 1, endRow - startRow + 1, header.width).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    if (values[r].join('') === '') continue;
    out.push(rowToObject_(tableKey, header, values[r], startRow + r));
  }
  return out;
}

/**
 * Finds rows whose `column` equals `value` exactly.
 * Uses the memo when available; otherwise TextFinder + bounding block read.
 * @param {string} tableKey
 * @param {string} column
 * @param {string} value
 * @param {{last:number}=} opts `last` limits to the N most recent matching rows
 * @return {Array<Object>}
 */
function dbFind(tableKey, column, value, opts) {
  opts = opts || {};
  value = String(value === null || value === undefined ? '' : value);
  if (value === '') return [];
  var memo = DB_STATE.memo[tableKey];
  if (memo) {
    var res = memo.filter(function (r) { return String(r[column]) === value; });
    return opts.last ? res.slice(-opts.last) : res;
  }
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  var colIdx = header.index[column];
  if (colIdx === undefined) fail('DB_ERROR', 'Column ' + column + ' not found in ' + tableKey);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var ranges = sh.getRange(2, colIdx + 1, lastRow - 1, 1)
    .createTextFinder(value).matchEntireCell(true).matchCase(true).findAll();
  if (!ranges.length) return [];
  var rowNums = ranges.map(function (rg) { return rg.getRow(); }).sort(function (a, b) { return a - b; });
  if (opts.last) rowNums = rowNums.slice(-opts.last);
  var block = dbReadBlock_(tableKey, rowNums[0], rowNums[rowNums.length - 1]);
  return block.filter(function (r) { return String(r[column]) === value; });
}

/** Returns the first matching row or null. */
function dbFindOne(tableKey, column, value) {
  var rows = dbFind(tableKey, column, value, { last: 1 });
  return rows.length ? rows[0] : null;
}

/**
 * Inserts multiple row objects in one batch write.
 * @return {Array<Object>} the inserted objects with _row set
 */
function dbInsertMany(tableKey, objs) {
  if (!objs || !objs.length) return [];
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  var startRow = sh.getLastRow() + 1;
  var values = objs.map(function (o) { return objectToRow_(tableKey, header, o); });
  var formatsRow = rowFormats_(tableKey, header);
  var formats = objs.map(function () { return formatsRow; });
  var range = sh.getRange(startRow, 1, values.length, header.width);
  range.setNumberFormats(formats);
  range.setValues(values);
  var def = SCHEMA[tableKey];
  var inserted = objs.map(function (o, i) {
    var copy = rowToObject_(tableKey, header, values[i], startRow + i);
    Object.keys(o).forEach(function (k) { if (def.columns.indexOf(k) < 0) copy[k] = o[k]; });
    return copy;
  });
  if (DB_STATE.memo[tableKey]) DB_STATE.memo[tableKey] = DB_STATE.memo[tableKey].concat(inserted);
  return inserted;
}

/** Inserts a single row object. */
function dbInsert(tableKey, obj) {
  return dbInsertMany(tableKey, [obj])[0];
}

/**
 * Updates one existing row (must carry _row). Only keys in `changes` are written,
 * but the full row is re-read first so concurrent edits to other columns are kept.
 * @return {Object} updated row object
 */
function dbUpdate(tableKey, rowObj, changes) {
  if (!rowObj || !rowObj._row) fail('DB_ERROR', 'dbUpdate requires a row with _row');
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  var range = sh.getRange(rowObj._row, 1, 1, header.width);
  var current = range.getValues()[0];
  var row = objectToRow_(tableKey, header, changes, current);
  range.setValues([row]);
  var updated = rowToObject_(tableKey, header, row, rowObj._row);
  Object.keys(changes).forEach(function (k) { rowObj[k] = updated[k]; });
  var memo = DB_STATE.memo[tableKey];
  if (memo) {
    for (var i = 0; i < memo.length; i++) {
      if (memo[i]._row === rowObj._row) { memo[i] = updated; break; }
    }
  }
  return updated;
}

/**
 * Updates many rows that were read in this execution (no re-read; caller holds lock).
 * Contiguous rows are written in a single setValues call.
 * @param {string} tableKey
 * @param {Array<{row:Object, changes:Object}>} updates
 */
function dbUpdateMany(tableKey, updates) {
  if (!updates.length) return;
  var sh = getTableSheet(tableKey);
  var header = getTableHeader(tableKey);
  var def = SCHEMA[tableKey];
  var sorted = updates.slice().sort(function (a, b) { return a.row._row - b.row._row; });
  var groups = [];
  sorted.forEach(function (u) {
    var g = groups[groups.length - 1];
    if (g && u.row._row === g.start + g.items.length) g.items.push(u);
    else groups.push({ start: u.row._row, items: [u] });
  });
  groups.forEach(function (g) {
    var range = sh.getRange(g.start, 1, g.items.length, header.width);
    var current = range.getValues();
    var values = g.items.map(function (u, i) {
      var merged = {};
      def.columns.forEach(function (c) { merged[c] = u.row[c]; });
      Object.keys(u.changes).forEach(function (k) { merged[k] = u.changes[k]; });
      return objectToRow_(tableKey, header, merged, current[i]);
    });
    range.setValues(values);
    g.items.forEach(function (u) { Object.keys(u.changes).forEach(function (k) { u.row[k] = u.changes[k]; }); });
  });
  delete DB_STATE.memo[tableKey];
}

/**
 * Physically deletes rows by sheet row number. Only used for ephemeral data
 * (expired sessions) and explicit sample-data cleanup.
 */
function dbDeleteRows(tableKey, rowNumbers) {
  if (!rowNumbers.length) return 0;
  var sh = getTableSheet(tableKey);
  var nums = rowNumbers.slice().sort(function (a, b) { return b - a; });
  var i = 0;
  while (i < nums.length) {
    var end = nums[i];
    var start = end;
    while (i + 1 < nums.length && nums[i + 1] === start - 1) { start--; i++; }
    sh.deleteRows(start, end - start + 1);
    i++;
  }
  delete DB_STATE.memo[tableKey];
  return rowNumbers.length;
}

/** Clears the per-execution memo (e.g. after acquiring a lock, to re-read fresh data). */
function dbInvalidate(tableKey) {
  if (tableKey) delete DB_STATE.memo[tableKey];
  else DB_STATE.memo = {};
}

/** Strips internal fields (_row) before sending to the client. */
function stripInternal(obj) {
  if (Array.isArray(obj)) return obj.map(stripInternal);
  var out = {};
  Object.keys(obj).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = obj[k]; });
  return out;
}

/* ------------------------------------------------------------------------- */
/* Script properties / cache helpers                                          */
/* ------------------------------------------------------------------------- */

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setScriptProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function cacheGet(key) {
  try {
    var v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

function cachePut(key, value, ttlSec) {
  try {
    var s = JSON.stringify(value);
    if (s.length < 95000) CacheService.getScriptCache().put(key, s, ttlSec || APP.CACHE_TTL_SEC);
  } catch (e) { /* cache is best-effort */ }
}

function cacheRemove(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) { /* ignore */ }
}

/**
 * Runs fn inside the script lock (critical section).
 * @param {Function} fn
 * @return {*} fn result
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.LOCK_TIMEOUT_MS)) fail('LOCK_TIMEOUT');
  try {
    dbInvalidate();
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

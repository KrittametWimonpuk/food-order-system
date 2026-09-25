/**
 * Utils.gs
 * ---------------------------------------------------------------------------
 * Pure helpers: IDs, date/time (Asia/Bangkok), type coercion, errors.
 * All timestamps in the database are stored as local Bangkok strings
 * "yyyy-MM-dd HH:mm:ss" so they sort lexicographically and never shift.
 */

/**
 * Application error carrying a machine-readable code.
 * @param {string} code Error code (see ERR in Config.gs)
 * @param {string=} message Human readable (Thai) message
 * @param {Object=} details Extra data returned to the client
 */
function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code || 'INTERNAL_ERROR';
  this.message = message || ERR[this.code] || ERR.INTERNAL_ERROR;
  this.details = details || null;
  this.stack = (new Error(this.message)).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

/** Throws AppError. */
function fail(code, message, details) {
  throw new AppError(code, message, details);
}

/** Throws AppError when condition is falsy. */
function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

/** @return {string} RFC4122 UUID */
function uuid() {
  return Utilities.getUuid();
}

/** @return {string} short request id, e.g. "REQ-1A2B3C4D" */
function newRequestId() {
  return 'REQ-' + Utilities.getUuid().replace(/-/g, '').substring(0, 10).toUpperCase();
}

/** Formats a Date in the system timezone. */
function formatDate(date, pattern) {
  return Utilities.formatDate(date, APP.TIMEZONE, pattern || 'yyyy-MM-dd HH:mm:ss');
}

/** @return {string} now as "yyyy-MM-dd HH:mm:ss" (Bangkok). */
function nowStr() {
  return formatDate(new Date(), 'yyyy-MM-dd HH:mm:ss');
}

/** @return {string} today as "yyyy-MM-dd" (Bangkok). */
function todayStr() {
  return formatDate(new Date(), 'yyyy-MM-dd');
}

/**
 * Parses a local Bangkok string ("yyyy-MM-dd", "yyyy-MM-dd HH:mm" or with seconds) to Date.
 * @return {Date|null}
 */
function parseLocal(str) {
  if (!str) return null;
  if (Object.prototype.toString.call(str) === '[object Date]') return str;
  var s = String(str).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  var iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':' +
    (m[6] || '00') + APP.TZ_OFFSET;
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Adds minutes to a local string / Date and returns a local string. */
function addMinutes(value, minutes) {
  var d = parseLocal(value) || new Date();
  return formatDate(new Date(d.getTime() + minutes * 60000));
}

/** Adds days to "yyyy-MM-dd" and returns "yyyy-MM-dd". */
function addDays(dateStr, days) {
  var d = parseLocal(dateStr);
  return formatDate(new Date(d.getTime() + days * 86400000), 'yyyy-MM-dd');
}

/** Combines "yyyy-MM-dd" with "HH:mm" -> "yyyy-MM-dd HH:mm:00". */
function combineDateTime(dateStr, timeStr) {
  return dateStr + ' ' + normalizeTime(timeStr) + ':00';
}

/** Normalises "8:0", "08:00", "0800" -> "08:00". Returns '' when invalid. */
function normalizeTime(t) {
  var s = String(t || '').trim();
  var m = s.match(/^(\d{1,2}):?(\d{2})(?::\d{2})?$/);
  if (!m) return '';
  var h = parseInt(m[1], 10);
  var min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return '';
  return (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min;
}

/** Day of week (0=Sunday) for "yyyy-MM-dd" in Bangkok. */
function dayOfWeek(dateStr) {
  return parseInt(formatDate(parseLocal(dateStr), 'u'), 10) % 7;
}

/** Milliseconds between two local strings (b - a). */
function diffMs(a, b) {
  return parseLocal(b).getTime() - parseLocal(a).getTime();
}

/** Converts sheet cell values (Date/boolean/number/string) into a normalised string. */
function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var t = formatDate(v, 'HH:mm:ss');
    return t === '00:00:00' ? formatDate(v, 'yyyy-MM-dd') : formatDate(v, 'yyyy-MM-dd HH:mm:ss');
  }
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return String(v);
}

/** Truthy check tolerant to "TRUE"/"true"/"1"/true/"yes". */
function toBool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  var s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES' || s === 'Y' || s === 'ON';
}

/** Converts to finite number, default when invalid. */
function toNum(v, def) {
  if (v === '' || v === null || v === undefined) return def === undefined ? 0 : def;
  var n = Number(v);
  return isFinite(n) ? n : (def === undefined ? 0 : def);
}

/** Converts to integer, default when invalid. */
function toInt(v, def) {
  var n = toNum(v, NaN);
  return isFinite(n) ? Math.floor(n) : (def === undefined ? 0 : def);
}

/** Money rounding to 2 decimals. */
function roundMoney(n) {
  return Math.round(toNum(n) * 100) / 100;
}

/** Safe JSON.parse. */
function safeJsonParse(s, def) {
  if (s === null || s === undefined || s === '') return def;
  try { return JSON.parse(s); } catch (e) { return def; }
}

/** JSON.stringify truncated for log cells (Sheets cell limit is 50k chars). */
function toLogString(v, max) {
  var s;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  }
  max = max || 5000;
  return s.length > max ? s.substring(0, max) + '…' : s;
}

/** Groups an array by key function. */
function groupBy(arr, fn) {
  var out = {};
  arr.forEach(function (x) {
    var k = fn(x);
    (out[k] = out[k] || []).push(x);
  });
  return out;
}

/** Index array by key. */
function indexBy(arr, key) {
  var out = {};
  arr.forEach(function (x) { out[x[key]] = x; });
  return out;
}

/** Pads number with zeros. */
function pad(n, len) {
  var s = String(n);
  while (s.length < len) s = '0' + s;
  return s;
}

/** Hex SHA-256 of a string (UTF-8). */
function sha256Hex(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytesToHex(bytes);
}

/** Byte array (signed) -> hex string. */
function bytesToHex(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out.push((b < 16 ? '0' : '') + b.toString(16));
  }
  return out.join('');
}

/** Random hex token of 2 UUIDs worth of entropy. */
function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** Thai date e.g. "25 กันยายน 2026". */
var THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม',
  'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function thaiDate(dateStr) {
  var d = parseLocal(dateStr);
  if (!d) return '';
  var p = formatDate(d, 'yyyy-M-d').split('-');
  return parseInt(p[2], 10) + ' ' + THAI_MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[0];
}

/** "dd/MM/yyyy" from local string. */
function slashDate(dateStr) {
  var d = parseLocal(dateStr);
  return d ? formatDate(d, 'dd/MM/yyyy') : '';
}

/** "HH:mm" from local string. */
function hhmm(dateTimeStr) {
  var s = String(dateTimeStr || '');
  return s.length >= 16 ? s.substring(11, 16) : s;
}

/**
 * Validation.gs
 * ---------------------------------------------------------------------------
 * Generic request validation used by the Router before any handler runs.
 * Domain-specific validation lives next to the domain logic in each service
 * (e.g. normalizeOrderItems_, validatePinFormat, buildWindowTimes_).
 */

var MAX_PAYLOAD_CHARS = 3000000; // allows a ~2MB base64 image upload
var MAX_PAYLOAD_DEPTH = 6;

/** True for a UUID string. */
function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
}

/** Validates an action name. */
function validateActionName(action) {
  var a = String(action || '');
  assert(/^[a-zA-Z]+\.[a-zA-Z]+$/.test(a) && a.length <= 60, 'UNKNOWN_ACTION');
  return a;
}

/**
 * Ensures the payload is a plain JSON object of bounded size / depth.
 * Returns a deep-cloned copy so handlers never see prototype tricks.
 * @param {*} payload
 * @return {Object}
 */
function validatePayload(payload) {
  if (payload === null || payload === undefined || payload === '') return {};
  var obj = payload;
  if (typeof payload === 'string') obj = safeJsonParse(payload, null);
  assert(obj && typeof obj === 'object' && !Array.isArray(obj), 'VALIDATION_ERROR', 'รูปแบบข้อมูลไม่ถูกต้อง');
  var json = JSON.stringify(obj);
  assert(json.length <= MAX_PAYLOAD_CHARS, 'VALIDATION_ERROR', 'ข้อมูลมีขนาดใหญ่เกินไป');
  var clone = JSON.parse(json);
  assert(depthOf_(clone, 0) <= MAX_PAYLOAD_DEPTH, 'VALIDATION_ERROR', 'รูปแบบข้อมูลซับซ้อนเกินไป');
  ['__proto__', 'constructor', 'prototype'].forEach(function (k) { delete clone[k]; });
  return clone;
}

function depthOf_(v, d) {
  if (!v || typeof v !== 'object' || d > MAX_PAYLOAD_DEPTH) return d;
  var max = d;
  Object.keys(v).forEach(function (k) { max = Math.max(max, depthOf_(v[k], d + 1)); });
  return max;
}

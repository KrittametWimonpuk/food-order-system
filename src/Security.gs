/**
 * Security.gs
 * ---------------------------------------------------------------------------
 * PIN hashing, token hashing, input sanitisation and RBAC helpers.
 *
 * PIN storage format:  v1$<salt>$<iterations>$<hex-sha256>
 *   hash_0 = SHA256(PIN_SALT(pepper from Script Properties) + ':' + salt + ':' + pin)
 *   hash_n = SHA256(hash_{n-1} + ':' + salt)
 * The pepper lives only in Script Properties, the per-user salt in the sheet.
 */

var PIN_HASH_ITERATIONS = 500;

/** Returns the global pepper, generating one on first use. */
function getPinPepper_() {
  var p = getScriptProp(PROP.PIN_SALT);
  if (!p) {
    p = randomToken();
    setScriptProp(PROP.PIN_SALT, p);
  }
  return p;
}

/** Returns the application secret, generating one on first use. */
function getAppSecret_() {
  var s = getScriptProp(PROP.APP_SECRET);
  if (!s) {
    s = randomToken();
    setScriptProp(PROP.APP_SECRET, s);
  }
  return s;
}

/**
 * Hashes a PIN with a fresh salt.
 * @param {string} pin
 * @return {string} encoded hash
 */
function hashPin(pin) {
  var salt = Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  return 'v1$' + salt + '$' + PIN_HASH_ITERATIONS + '$' + computePinHash_(pin, salt, PIN_HASH_ITERATIONS);
}

function computePinHash_(pin, salt, iterations) {
  var h = sha256Hex(getPinPepper_() + ':' + salt + ':' + String(pin));
  for (var i = 1; i < iterations; i++) h = sha256Hex(h + ':' + salt);
  return h;
}

/**
 * Verifies a PIN against the stored hash (constant-time compare).
 * @return {boolean}
 */
function verifyPin(pin, stored) {
  if (!stored) return false;
  var parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  var computed = computePinHash_(pin, parts[1], toInt(parts[2], PIN_HASH_ITERATIONS));
  return constantTimeEquals_(computed, parts[3]);
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Hash of a session token as stored in the sheet (token itself is never stored). */
function hashToken(token) {
  return sha256Hex(getAppSecret_() + ':' + String(token));
}

/** Validates a PIN format. Throws VALIDATION_ERROR when invalid. */
function validatePinFormat(pin) {
  var min = Math.max(4, cfgInt('PIN_MIN_LENGTH', 4));
  var s = String(pin || '');
  assert(/^\d+$/.test(s), 'VALIDATION_ERROR', 'PIN ต้องเป็นตัวเลขเท่านั้น');
  assert(s.length >= min && s.length <= 8, 'VALIDATION_ERROR', 'PIN ต้องมีความยาว ' + min + '-8 หลัก');
  assert(!/^(\d)\1+$/.test(s), 'VALIDATION_ERROR', 'PIN ห้ามเป็นตัวเลขซ้ำกันทั้งหมด');
  assert('0123456789'.indexOf(s) < 0 && '9876543210'.indexOf(s) < 0, 'VALIDATION_ERROR',
    'PIN ห้ามเป็นตัวเลขเรียงกัน');
  return s;
}

/**
 * Sanitises free text: strips control chars and angle brackets, trims, limits length.
 * Output escaping is still done on the client (escapeHtml) - defence in depth.
 */
function sanitizeText(v, maxLen) {
  var s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[<>]/g, '').trim();
  // Formula injection is prevented by '@' (plain text) cell format and csvCell().
  maxLen = maxLen || 500;
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

/** Escapes a value for CSV and neutralises formula injection. */
function csvCell(v) {
  var s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** True when role is in roles list. */
function hasRole(user, roles) {
  return !!user && roles.indexOf(user.role) >= 0;
}

/** Throws ACCESS_DENIED unless the user has one of the roles. */
function requireRole(user, roles) {
  if (!hasRole(user, roles)) fail('ACCESS_DENIED');
}

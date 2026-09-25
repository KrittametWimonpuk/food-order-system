/**
 * Session.gs
 * ---------------------------------------------------------------------------
 * Server-side sessions stored in 03_USER_SESSIONS (token hash only) with a
 * CacheService layer so most requests don't touch the sheet.
 * Role is ALWAYS re-read from the employee record - never trusted from client.
 */

var SESSION_TOUCH_MINUTES = 5;

function sessionCacheKey_(tokenHash) { return 'sess_' + tokenHash.substring(0, 40); }
function employeeCacheKey_(employeeId) { return 'emp_' + employeeId; }

/** Computes the expiry for a session. */
function sessionExpiry_(remember) {
  if (remember) return addMinutes(nowStr(), Math.max(1, cfgInt('REMEMBER_DAYS', 30)) * 1440);
  return addMinutes(nowStr(), Math.max(5, cfgInt('SESSION_TIMEOUT_MINUTES', 120)));
}

/**
 * Creates a session for an employee.
 * @return {{token:string, expiresAt:string}}
 */
function createSession(employee, remember, userAgent) {
  var token = randomToken();
  var tokenHash = hashToken(token);
  var now = nowStr();
  var row = dbInsert('SESSIONS', {
    session_id: uuid(),
    session_token: tokenHash,
    employee_id: employee.employee_id,
    role: employee.role,
    created_at: now,
    expires_at: sessionExpiry_(remember),
    last_activity: now,
    revoked: 'FALSE',
    remember: remember ? 'TRUE' : 'FALSE',
    user_agent: sanitizeText(userAgent, 200)
  });
  cachePut(sessionCacheKey_(tokenHash), row, 600);
  return { token: token, expiresAt: row.expires_at };
}

/** Loads an employee record, cached briefly. */
function getEmployeeCached(employeeId) {
  var key = employeeCacheKey_(employeeId);
  var emp = cacheGet(key);
  if (emp) return emp;
  emp = dbFindOne('EMPLOYEES', 'employee_id', employeeId);
  if (emp) cachePut(key, publicEmployee(emp, true), 120);
  return emp ? publicEmployee(emp, true) : null;
}

/** Removes the cached employee (after edits). */
function invalidateEmployeeCache(employeeId) {
  cacheRemove(employeeCacheKey_(employeeId));
}

/**
 * Validates a session token and returns the current user.
 * @param {string} token
 * @return {Object} user {employee_id, employee_code, name, department, role, must_change_pin, session_id}
 */
function validateSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 100) fail('SESSION_EXPIRED');
  var tokenHash = hashToken(token);
  var ck = sessionCacheKey_(tokenHash);
  var sess = cacheGet(ck);
  if (!sess) {
    sess = dbFindOne('SESSIONS', 'session_token', tokenHash);
    if (!sess) fail('SESSION_EXPIRED');
  }
  var now = nowStr();
  if (toBool(sess.revoked) || !sess.expires_at || sess.expires_at <= now) {
    cacheRemove(ck);
    fail('SESSION_EXPIRED');
  }
  var emp = getEmployeeCached(sess.employee_id);
  if (!emp) fail('SESSION_EXPIRED');
  if (emp.status !== 'ACTIVE') {
    revokeSessionRow_(sess, ck);
    fail('EMPLOYEE_DISABLED');
  }
  // Sliding expiry, written to the sheet at most every SESSION_TOUCH_MINUTES.
  if (diffMs(sess.last_activity || sess.created_at, now) > SESSION_TOUCH_MINUTES * 60000) {
    var changes = { last_activity: now };
    if (!toBool(sess.remember)) changes.expires_at = sessionExpiry_(false);
    try {
      var fresh = dbFindOne('SESSIONS', 'session_token', tokenHash);
      if (fresh) {
        dbUpdate('SESSIONS', fresh, changes);
        Object.keys(changes).forEach(function (k) { sess[k] = changes[k]; });
        sess._row = fresh._row;
      }
    } catch (e) { /* non-critical */ }
  }
  cachePut(ck, sess, 600);
  return {
    employee_id: emp.employee_id,
    employee_code: emp.employee_code,
    name: emp.name,
    department: emp.department,
    role: emp.role,
    must_change_pin: toBool(emp.must_change_pin),
    session_id: sess.session_id,
    session_expires_at: sess.expires_at
  };
}

function revokeSessionRow_(sess, ck) {
  cacheRemove(ck);
  try {
    var fresh = dbFindOne('SESSIONS', 'session_token', sess.session_token);
    if (fresh) dbUpdate('SESSIONS', fresh, { revoked: 'TRUE' });
  } catch (e) { /* ignore */ }
}

/** Revokes a session by raw token (logout). */
function revokeSession(token) {
  if (!token) return;
  var tokenHash = hashToken(token);
  var ck = sessionCacheKey_(tokenHash);
  cacheRemove(ck);
  var sess = dbFindOne('SESSIONS', 'session_token', tokenHash);
  if (sess && !toBool(sess.revoked)) dbUpdate('SESSIONS', sess, { revoked: 'TRUE' });
}

/**
 * Revokes every active session of an employee (disable / reset PIN / role change).
 * @param {string} employeeId
 * @param {string=} exceptSessionId keep this session alive (e.g. user changing own PIN)
 */
function revokeAllSessions(employeeId, exceptSessionId) {
  var rows = dbFind('SESSIONS', 'employee_id', employeeId, { last: 200 });
  var now = nowStr();
  var updates = [];
  rows.forEach(function (s) {
    if (s.session_id === exceptSessionId) return;
    if (!toBool(s.revoked) && s.expires_at > now) {
      updates.push({ row: s, changes: { revoked: 'TRUE' } });
      cacheRemove(sessionCacheKey_(s.session_token));
    }
  });
  if (updates.length) dbUpdateMany('SESSIONS', updates);
  invalidateEmployeeCache(employeeId);
  return updates.length;
}

/**
 * Deletes expired/revoked session rows older than 2 days (ephemeral data only).
 * @return {number} rows removed
 */
function cleanupSessions() {
  var cutoff = addMinutes(nowStr(), -2 * 1440);
  var rows = dbAll('SESSIONS');
  var toDelete = rows.filter(function (s) {
    return (toBool(s.revoked) && s.last_activity < cutoff) || (s.expires_at && s.expires_at < cutoff);
  }).map(function (s) { return s._row; });
  return dbDeleteRows('SESSIONS', toDelete);
}

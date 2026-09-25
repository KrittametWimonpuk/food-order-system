/**
 * NotificationService.gs
 * ---------------------------------------------------------------------------
 * Notification queue (10_NOTIFICATION_QUEUE). Business transactions only
 * INSERT into the queue; delivery happens later (scheduler / after commit).
 * A LINE outage therefore never blocks ordering.
 *
 * Status: PENDING -> PROCESSING -> SENT
 *                               -> RETRY (retry_count < 3, exponential backoff)
 *                               -> FAILED (after 3 retries; admin can retry manually)
 */

var QUEUE_SCAN_ROWS = 500;
var QUEUE_STUCK_MINUTES = 10;
var QUEUE_EXPIRE_HOURS = 24;

/** Most recent queue rows (tail of the sheet). */
function getRecentNotifications_(n) {
  var sh = getTableSheet('NOTIFICATION_QUEUE');
  var last = sh.getLastRow();
  if (last < 2) return [];
  return dbReadBlock_('NOTIFICATION_QUEUE', Math.max(2, last - n + 1), last);
}

/**
 * Adds a message to the queue. When `dedupeKey` is given and a non-failed row
 * with the same key exists, nothing is queued.
 * @param {string} type NOTI_TYPE
 * @param {string} text message text
 * @param {string=} dedupeKey
 * @param {string=} recipient override LINE target
 * @return {Object|null} queued row or null when deduplicated / disabled
 */
function enqueueNotification(type, text, dedupeKey, recipient) {
  if (!cfgBool('LINE_ENABLED')) return null;
  if (dedupeKey) {
    var existing = dbFindOne('NOTIFICATION_QUEUE', 'dedupe_key', dedupeKey);
    if (existing && existing.status !== NOTI_STATUS.FAILED) return null;
  }
  return dbInsert('NOTIFICATION_QUEUE', {
    notification_id: uuid(),
    type: type,
    recipient: recipient || '',
    payload: JSON.stringify({ text: text }),
    status: NOTI_STATUS.PENDING,
    retry_count: 0,
    created_at: nowStr(),
    sent_at: '',
    last_error: '',
    next_retry_at: '',
    dedupe_key: dedupeKey || ''
  });
}

/** INSTANT mode: one message per new / edited / cancelled order. */
function enqueueInstantOrder(order, kind) {
  var head = kind === 'CANCEL' ? '❌ ยกเลิก Order' : (kind === 'EDIT' ? '✏️ แก้ไข Order' : '🆕 Order ใหม่');
  var lines = [head, order.order_no, order.employee_name + ' (' + order.employee_code + ') - ' + order.department, ''];
  parseOrderItems(order).forEach(function (i) { lines.push(i.name + ' x' + i.qty + (i.note ? ' (' + i.note + ')' : '')); });
  if (order.note) lines.push('หมายเหตุ: ' + order.note);
  lines.push('');
  lines.push('รวม ' + order.total_qty + ' กล่อง ' + order.total_amount + ' บาท');
  return enqueueNotification(NOTI_TYPE.ORDER_INSTANT, lines.join('\n'), 'instant_' + order.order_id + '_v' + order.version);
}

/** Final summary for a window (used by MealService close hook). */
function enqueueFinalSummary(w) {
  return sendFinalSummary(w);
}

/**
 * SUMMARY mode: queues a periodic summary for open windows every
 * SUMMARY_INTERVAL_MINUTES (only when there are orders).
 * @return {number} summaries queued
 */
function enqueueDueSummaries() {
  if (cfg('LINE_NOTIFICATION_MODE') !== 'SUMMARY') return 0;
  var interval = Math.max(5, cfgInt('SUMMARY_INTERVAL_MINUTES', 30));
  var now = nowStr();
  var queued = 0;
  getWindowsByDate(todayStr()).forEach(function (w) {
    if (computeWindowStatus(w, now) !== WINDOW_STATUS.OPEN) return;
    if (w.last_summary_at && diffMs(w.last_summary_at, now) < (interval * 60000) - 60000) return;
    // Align to the interval grid measured from the opening time (e.g. 08:00, 08:30, 09:00 ...).
    var minsSinceOpen = Math.floor(diffMs(w.open_at, now) / 60000);
    if (minsSinceOpen < interval - 1) return;
    var slot = Math.floor((minsSinceOpen + 1) / interval);
    var s = buildSummaryText(w);
    var fresh = getWindowById(w.window_id);
    dbUpdate('MEAL_WINDOWS', fresh, { last_summary_at: now });
    if (!s.orders) return;
    if (enqueueNotification(NOTI_TYPE.ORDER_SUMMARY, s.text, 'summary_' + w.window_id + '_' + slot)) queued++;
  });
  return queued;
}

/**
 * Sends queued messages. Rows are claimed under the lock (PROCESSING) so
 * parallel executions never send the same message twice.
 * @param {number=} limit max messages per run
 * @return {{sent:number, failed:number, retry:number}}
 */
function processNotificationQueue(limit) {
  limit = limit || 20;
  var result = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  if (!cfgBool('LINE_ENABLED')) return result;
  var configured = isLineConfigured();
  var claimed = withLock(function () {
    var now = nowStr();
    var rows = getRecentNotifications_(QUEUE_SCAN_ROWS);
    var updates = [], picked = [];
    rows.forEach(function (n) {
      var age = diffMs(n.created_at || now, now);
      if (n.status === NOTI_STATUS.PROCESSING && age > QUEUE_STUCK_MINUTES * 60000 && n.type !== NOTI_TYPE.TEST) {
        updates.push({ row: n, changes: { status: NOTI_STATUS.RETRY, last_error: 'stuck in PROCESSING' } });
        return;
      }
      if (n.status !== NOTI_STATUS.PENDING && n.status !== NOTI_STATUS.RETRY) return;
      if (age > QUEUE_EXPIRE_HOURS * 3600000) {
        updates.push({ row: n, changes: { status: NOTI_STATUS.FAILED, last_error: 'expired (ไม่ได้ส่งภายใน 24 ชั่วโมง)' } });
        return;
      }
      if (!configured) return;
      if (n.status === NOTI_STATUS.RETRY && n.next_retry_at && n.next_retry_at > now) return;
      if (picked.length >= limit) return;
      picked.push(n);
      updates.push({ row: n, changes: { status: NOTI_STATUS.PROCESSING } });
    });
    dbUpdateMany('NOTIFICATION_QUEUE', updates);
    return picked;
  });
  claimed.forEach(function (n) {
    var payload = safeJsonParse(n.payload, {});
    try {
      sendLineMessage(payload.text || '', n.recipient || null, n.notification_id);
      markNotification_(n, { status: NOTI_STATUS.SENT, sent_at: nowStr(), last_error: '' });
      result.sent++;
    } catch (e) {
      var retries = toInt(n.retry_count) + 1;
      if (retries >= MAX_NOTIFICATION_RETRY || e.code === 'LINE_NOT_CONFIGURED') {
        markNotification_(n, { status: NOTI_STATUS.FAILED, retry_count: retries, last_error: toLogString(e.message, 500) });
        result.failed++;
        logError(e, 'NOTIFICATION', 'processNotificationQueue');
      } else {
        markNotification_(n, {
          status: NOTI_STATUS.RETRY, retry_count: retries, last_error: toLogString(e.message, 500),
          next_retry_at: addMinutes(nowStr(), Math.pow(2, retries))
        });
        result.retry++;
      }
    }
  });
  return result;
}

function markNotification_(n, changes) {
  var fresh = dbFindOne('NOTIFICATION_QUEUE', 'notification_id', n.notification_id);
  if (fresh) dbUpdate('NOTIFICATION_QUEUE', fresh, changes);
}

/**
 * Lists queue rows for the admin LINE page.
 * @param {{status?:string}} p
 */
function listNotifications(user, p) {
  p = p || {};
  var status = String(p.status || '').toUpperCase();
  var rows = getRecentNotifications_(QUEUE_SCAN_ROWS).reverse().filter(function (n) { return !status || n.status === status; })
    .slice(0, 100).map(function (n) {
      var o = stripInternal(n);
      o.text = (safeJsonParse(n.payload, {}) || {}).text || '';
      delete o.payload;
      return o;
    });
  return { rows: rows };
}

/**
 * Manually re-queues a FAILED (or RETRY) notification and tries to send now.
 * @param {{notification_id:string}} p
 */
function retryNotification(user, p) {
  var n = dbFindOne('NOTIFICATION_QUEUE', 'notification_id', String(p && p.notification_id || ''));
  assert(n, 'NOT_FOUND');
  assert(n.status === NOTI_STATUS.FAILED || n.status === NOTI_STATUS.RETRY, 'VALIDATION_ERROR', 'รายการนี้ไม่อยู่ในสถานะที่ Retry ได้');
  assert(isLineConfigured(), 'LINE_NOT_CONFIGURED');
  dbUpdate('NOTIFICATION_QUEUE', n, { status: NOTI_STATUS.PENDING, retry_count: 0, next_retry_at: '', created_at: nowStr() });
  writeAudit(user, 'RETRY_NOTIFICATION', 'LINE', n.notification_id, n.status, 'PENDING');
  var r = processNotificationQueue(10);
  return { requeued: true, result: r };
}

/**
 * Admin/Kitchen: queue a summary of a window right now and try to send it.
 * @param {{window_id:string, final?:boolean}} p
 */
function sendSummaryNow(user, p) {
  var w = getWindowById(p && p.window_id);
  var text = p.final ? buildFinalSummaryText(w).text : buildSummaryText(w).text;
  var row = enqueueNotification(p.final ? NOTI_TYPE.FINAL_SUMMARY : NOTI_TYPE.ORDER_SUMMARY, text, '');
  assert(row, 'VALIDATION_ERROR', 'การส่ง LINE ถูกปิดอยู่ (LINE_ENABLED = FALSE)');
  writeAudit(user, 'SEND_SUMMARY_NOW', 'LINE', w.window_id, '', p.final ? 'FINAL' : 'SUMMARY');
  var r = processNotificationQueue(10);
  return { queued: true, result: r, preview: text };
}

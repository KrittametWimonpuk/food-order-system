/**
 * LineService.gs
 * ---------------------------------------------------------------------------
 * LINE Official Account - Messaging API (push message). NOT LINE Notify.
 * Secrets are read from Script Properties only:
 *   LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LINE_TARGET_ID
 */

var LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
var LINE_TEXT_LIMIT = 4900;

/** @return {{token:string, secret:string, target:string}} */
function getLineConfig() {
  return {
    token: getScriptProp(PROP.LINE_CHANNEL_ACCESS_TOKEN),
    secret: getScriptProp(PROP.LINE_CHANNEL_SECRET),
    target: getScriptProp(PROP.LINE_TARGET_ID)
  };
}

/** True when token + target are configured. */
function isLineConfigured() {
  var c = getLineConfig();
  return !!(c.token && c.target);
}

/** Masks a secret for display: abcd…wxyz */
function maskSecret(s) {
  s = String(s || '');
  if (!s) return '';
  if (s.length <= 10) return s.charAt(0) + '•••' + s.charAt(s.length - 1);
  return s.substring(0, 4) + '••••••' + s.substring(s.length - 4);
}

/**
 * Sends a text push message via LINE Messaging API.
 * @param {string} text
 * @param {string=} to recipient (user/group/room id); defaults to LINE_TARGET_ID
 * @param {string=} retryKey UUID for X-Line-Retry-Key (prevents duplicate delivery on retry)
 * @return {{status:number}}
 * @throws AppError LINE_NOT_CONFIGURED | LINE_SEND_FAILED
 */
function sendLineMessage(text, to, retryKey) {
  var c = getLineConfig();
  var target = to || c.target;
  if (!c.token || !target) fail('LINE_NOT_CONFIGURED');
  var body = String(text || '');
  if (body.length > LINE_TEXT_LIMIT) body = body.substring(0, LINE_TEXT_LIMIT) + '…';
  var headers = { Authorization: 'Bearer ' + c.token };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  var res = UrlFetchApp.fetch(LINE_PUSH_URL, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: headers,
    payload: JSON.stringify({ to: target, messages: [{ type: 'text', text: body }] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  // 409 with a retry key = message was already accepted earlier -> treat as success.
  if (code === 200 || (code === 409 && retryKey)) return { status: code };
  fail('LINE_SEND_FAILED', ERR.LINE_SEND_FAILED + ' (HTTP ' + code + '): ' + String(res.getContentText()).substring(0, 300));
}

/** Kitchen dashboard link (BASE_URL Script Property or current deployment URL). */
function getAppUrl() {
  var base = getScriptProp(PROP.BASE_URL);
  if (!base) {
    try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
  }
  return base;
}

/** Aggregated per-menu counts (active orders only) for a window. */
function windowMenuCounts_(w) {
  var orders = dbFind('ORDERS', 'window_id', w.window_id).filter(function (o) { return o.status !== ORDER_STATUS.CANCELLED; });
  return aggregateOrders(orders);
}

/** Builds the periodic summary text. */
function buildSummaryText(w) {
  var agg = windowMenuCounts_(w);
  var lines = ['🍱 สรุปยอดอาหาร', (MEAL_LABEL_TH[w.meal] || w.meal) + ' ' + slashDate(w.date), 'เวลา ' + hhmm(nowStr()) + ' น.', ''];
  if (!agg.byMenu.length) lines.push('ยังไม่มีรายการสั่งอาหาร');
  agg.byMenu.forEach(function (m) { lines.push(m.name + ' ' + m.qty); });
  lines.push('');
  lines.push('รวม ' + agg.kpi.qty + ' กล่อง (' + agg.kpi.orders + ' Order)');
  lines.push('ปิดรับ ' + hhmm(w.close_at) + ' น.');
  return { text: lines.join('\n'), orders: agg.kpi.orders, qty: agg.kpi.qty };
}

/** Builds the final (cutoff) summary text. */
function buildFinalSummaryText(w) {
  var agg = windowMenuCounts_(w);
  var lines = ['🔴 ปิดรับ Order แล้ว', (MEAL_LABEL_TH[w.meal] || w.meal) + ' ' + slashDate(w.date), ''];
  if (!agg.byMenu.length) lines.push('ไม่มีรายการสั่งอาหาร');
  agg.byMenu.forEach(function (m) { lines.push(m.name + ' ' + m.qty); });
  lines.push('');
  lines.push('รวม ' + agg.kpi.orders + ' Order');
  lines.push(agg.kpi.qty + ' กล่อง');
  lines.push('รับอาหาร ' + hhmm(w.pickup_start) + '-' + hhmm(w.pickup_end) + ' น.');
  var url = getAppUrl();
  if (url) {
    lines.push('');
    lines.push('Kitchen Dashboard:');
    lines.push(url + '?page=kitchen');
  }
  return { text: lines.join('\n'), orders: agg.kpi.orders, qty: agg.kpi.qty };
}

/**
 * Queues a summary for the window (periodic / manual).
 * @param {Object} w window row
 * @param {string=} dedupeKey
 */
function sendOrderSummary(w, dedupeKey) {
  var s = buildSummaryText(w);
  return enqueueNotification(NOTI_TYPE.ORDER_SUMMARY, s.text, dedupeKey || '');
}

/** Queues the final summary for the window (once per window). */
function sendFinalSummary(w) {
  var s = buildFinalSummaryText(w);
  return enqueueNotification(NOTI_TYPE.FINAL_SUMMARY, s.text, 'final_' + w.window_id);
}

/** Queues a system alert (e.g. backup failure). */
function sendSystemAlert(message, dedupeKey) {
  return enqueueNotification(NOTI_TYPE.SYSTEM_ALERT, '⚠️ แจ้งเตือนระบบ\n\n' + message + '\n\nเวลา: ' + thaiDateTime(nowStr()), dedupeKey || '');
}

/**
 * Sends a test message immediately (admin button) and records it in the queue.
 */
function testLineNotification(user) {
  var text = '✅ Factory Food Ordering System\n\nLINE Messaging API เชื่อมต่อสำเร็จ\n\nเวลา: ' + thaiDateTime(nowStr()) +
    '\nโดย: ' + user.name + ' (' + user.employee_code + ')';
  var id = uuid();
  var now = nowStr();
  var row = dbInsert('NOTIFICATION_QUEUE', {
    notification_id: id, type: NOTI_TYPE.TEST, recipient: getLineConfig().target, payload: JSON.stringify({ text: text }),
    status: NOTI_STATUS.PROCESSING, retry_count: 0, created_at: now, sent_at: '', last_error: '', next_retry_at: '', dedupe_key: ''
  });
  try {
    sendLineMessage(text, null, id);
    dbUpdate('NOTIFICATION_QUEUE', row, { status: NOTI_STATUS.SENT, sent_at: nowStr() });
    writeAudit(user, 'TEST_LINE', 'LINE', id, '', 'SENT');
    return { sent: true, message: 'ส่งข้อความทดสอบสำเร็จ' };
  } catch (e) {
    dbUpdate('NOTIFICATION_QUEUE', row, { status: NOTI_STATUS.FAILED, last_error: toLogString(e.message, 500) });
    logError(e, 'LINE', 'testLineNotification', user.employee_id);
    writeAudit(user, 'TEST_LINE', 'LINE', id, '', 'FAILED');
    throw e;
  }
}

/** LINE settings page data (never returns full secrets). */
function getLineStatus(user) {
  var c = getLineConfig();
  var stats = { PENDING: 0, PROCESSING: 0, SENT: 0, FAILED: 0, RETRY: 0 };
  var lastSent = '';
  getRecentNotifications_(500).forEach(function (n) {
    stats[n.status] = (stats[n.status] || 0) + 1;
    if (n.status === NOTI_STATUS.SENT && n.sent_at > lastSent) lastSent = n.sent_at;
  });
  return {
    connected: !!(c.token && c.target),
    tokenSet: !!c.token,
    secretSet: !!c.secret,
    tokenMasked: maskSecret(c.token),
    targetId: maskSecret(c.target),
    targetSet: !!c.target,
    mode: cfg('LINE_NOTIFICATION_MODE') || 'SUMMARY',
    interval: cfgInt('SUMMARY_INTERVAL_MINUTES', 30),
    enabled: cfgBool('LINE_ENABLED'),
    webhookCapture: cfgBool('LINE_WEBHOOK_CAPTURE'),
    webhookUrl: getAppUrl(),
    queue: stats,
    lastSent: lastSent
  };
}

/**
 * Handles LINE webhook POST (optional). Apps Script cannot read request headers,
 * so the X-Line-Signature cannot be verified; the handler therefore only logs
 * source IDs (to help find the Group ID) when LINE_WEBHOOK_CAPTURE = TRUE and
 * never performs any privileged action.
 */
function handleLineWebhook(e) {
  if (!cfgBool('LINE_WEBHOOK_CAPTURE')) return;
  var body = safeJsonParse(e && e.postData && e.postData.contents, null);
  if (!body || !Array.isArray(body.events)) return;
  body.events.slice(0, 20).forEach(function (ev) {
    var src = ev.source || {};
    systemLog('INFO', 'LINE', 'WEBHOOK_' + String(ev.type || '').toUpperCase(),
      'LINE source ' + (src.type || '') + ': ' + (src.groupId || src.roomId || src.userId || ''),
      { type: src.type, groupId: src.groupId || '', roomId: src.roomId || '', userId: src.userId || '' });
  });
}

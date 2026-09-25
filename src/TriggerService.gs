/**
 * TriggerService.gs
 * ---------------------------------------------------------------------------
 * Time-driven triggers. Instead of one trigger per clock time (08:00 open,
 * 09:00 summary, 10:30 close ...), a single scheduler runs every N minutes and
 * derives what to do from the meal-window times + config. So every time is
 * configurable in 01_CONFIG / Meal Window page - nothing is hardcoded.
 *
 *   runScheduler     every SCHEDULER_INTERVAL_MINUTES (default 5)
 *     - auto-create today's meal windows (+ daily menu)
 *     - persist status transitions DRAFT->OPEN->CLOSED->PREPARING->COMPLETED
 *       (close hook = daily summary + final LINE summary, complete hook = NO_SHOW)
 *     - periodic LINE summary (SUMMARY mode)
 *     - process the notification queue (send + retry)
 *   dailyBackupJob   every day at BACKUP_HOUR
 *   dailyMaintenance every day at 00:xx (session cleanup, counters cleanup)
 */

var TRIGGER_HANDLERS = ['runScheduler', 'dailyBackupJob', 'dailyMaintenance'];
var VALID_INTERVALS = [1, 5, 10, 15, 30];

/**
 * (Re)installs all triggers. Safe to run many times - removes old ones first.
 * Run from the Apps Script editor or the Admin > Settings page.
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  var interval = cfgInt('SCHEDULER_INTERVAL_MINUTES', 5);
  if (VALID_INTERVALS.indexOf(interval) < 0) interval = 5;
  ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(interval).create();
  var hour = Math.min(23, Math.max(0, cfgInt('BACKUP_HOUR', 18)));
  ScriptApp.newTrigger('dailyBackupJob').timeBased().everyDays(1).atHour(hour).inTimezone(APP.TIMEZONE).create();
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(0).nearMinute(5).inTimezone(APP.TIMEZONE).create();
  systemLog('INFO', 'TRIGGER', 'SETUP_TRIGGERS', 'ติดตั้ง Trigger แล้ว', { schedulerMinutes: interval, backupHour: hour });
  Logger.log('Triggers installed: scheduler every ' + interval + ' min, backup at ' + hour + ':00, maintenance 00:05');
  return getTriggerInfo_();
}

/** Removes all project triggers created by this system. */
function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  systemLog('INFO', 'TRIGGER', 'REMOVE_TRIGGERS', 'ลบ Trigger ' + n + ' รายการ');
  return n;
}

function getTriggerInfo_() {
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0;
  }).map(function (t) { return { handler: t.getHandlerFunction(), id: t.getUniqueId() }; });
}

/** Admin API: trigger status. */
function getTriggerStatus(user) {
  var list = getTriggerInfo_();
  return {
    installed: list,
    missing: TRIGGER_HANDLERS.filter(function (h) { return !list.some(function (t) { return t.handler === h; }); }),
    lastRun: getScriptProp('SCHEDULER_LAST_RUN')
  };
}

/** Admin API: install triggers. */
function installTriggers(user) {
  var res = setupTriggers();
  writeAudit(user, 'SETUP_TRIGGERS', 'SYSTEM', '', '', res.map(function (t) { return t.handler; }));
  return getTriggerStatus(user);
}

/** Runs a scheduler step isolated from the others. */
function runStep_(name, fn, report) {
  try {
    report[name] = fn();
  } catch (e) {
    report[name] = 'ERROR';
    logError(e, 'SCHEDULER', name);
  }
}

/**
 * Scheduler entry point (time-driven trigger).
 * Each step is isolated: a LINE failure never stops window status updates.
 */
function runScheduler() {
  REQUEST_CTX.requestId = 'SCHED-' + formatDate(new Date(), 'HHmmss');
  var report = {};
  runStep_('ensureWindows', function () { return ensureWindowsForDate(todayStr()); }, report);
  runStep_('syncStatuses', syncWindowStatuses, report);
  runStep_('summaries', enqueueDueSummaries, report);
  runStep_('queue', function () { return processNotificationQueue(20); }, report);
  setScriptProp('SCHEDULER_LAST_RUN', nowStr());
  return report;
}

/** Daily backup trigger. */
function dailyBackupJob() {
  REQUEST_CTX.requestId = 'BACKUP-' + formatDate(new Date(), 'yyyyMMdd');
  if (!cfgBool('BACKUP_ENABLED')) return null;
  try { return runBackup('SCHEDULED'); } catch (e) { return null; }
}

/** Daily maintenance: session cleanup + old order-number counters. */
function dailyMaintenance() {
  REQUEST_CTX.requestId = 'MAINT-' + formatDate(new Date(), 'yyyyMMdd');
  var report = {};
  runStep_('sessions', cleanupSessions, report);
  runStep_('counters', cleanupOrderCounters_, report);
  runStep_('ensureWindows', function () { return ensureWindowsForDate(todayStr()); }, report);
  systemLog('INFO', 'SCHEDULER', 'DAILY_MAINTENANCE', 'Daily maintenance', report);
  return report;
}

/** Deletes SEQ_yymmdd script properties older than 7 days. */
function cleanupOrderCounters_() {
  var props = PropertiesService.getScriptProperties();
  var keep = addDays(todayStr(), -7);
  var keepKey = 'SEQ_' + keep.substring(2, 4) + keep.substring(5, 7) + keep.substring(8, 10);
  var removed = 0;
  props.getKeys().forEach(function (k) {
    if (/^SEQ_\d{6}$/.test(k) && k < keepKey) { props.deleteProperty(k); removed++; }
  });
  return removed;
}

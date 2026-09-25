/**
 * BackupService.gs
 * ---------------------------------------------------------------------------
 * Copies the database spreadsheet to Drive:
 *   FoodFactory-Backup/YYYY/MM/FoodFactory-DB_YYYY-MM-DD_HHmmss
 * Every run creates a NEW file (never overwrites). Failures are logged and
 * alerted through the notification queue; they never affect ordering.
 */

var BACKUP_ROOT_NAME = 'FoodFactory-Backup';

/** Returns (creating if needed) a child folder by name. */
function getOrCreateChildFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Backup root folder (BACKUP_FOLDER_ID Script Property or auto-created). */
function getBackupRoot_() {
  return getOrCreateFolderByProp_(PROP.BACKUP_FOLDER_ID, BACKUP_ROOT_NAME);
}

/**
 * Runs a backup now.
 * @param {string=} reason MANUAL | SCHEDULED
 * @return {{fileId:string, url:string, name:string, path:string}}
 */
function runBackup(reason) {
  try {
    var ss = getDatabase();
    var now = new Date();
    var yyyy = formatDate(now, 'yyyy'), mm = formatDate(now, 'MM');
    var folder = getOrCreateChildFolder_(getOrCreateChildFolder_(getBackupRoot_(), yyyy), mm);
    var name = 'FoodFactory-DB_' + formatDate(now, 'yyyy-MM-dd_HHmmss');
    var copy = DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
    var info = { fileId: copy.getId(), url: copy.getUrl(), name: name, path: BACKUP_ROOT_NAME + '/' + yyyy + '/' + mm + '/' };
    systemLog('INFO', 'BACKUP', 'BACKUP_OK', 'สำรองข้อมูลสำเร็จ (' + (reason || 'MANUAL') + '): ' + name, info);
    try { cleanupOldBackups_(); } catch (e2) { logError(e2, 'BACKUP', 'cleanupOldBackups_'); }
    return info;
  } catch (e) {
    logError(e, 'BACKUP', 'runBackup');
    systemLog('ERROR', 'BACKUP', 'BACKUP_FAILED', String(e.message || e));
    try { sendSystemAlert('สำรองข้อมูลไม่สำเร็จ: ' + String(e.message || e).substring(0, 200), 'backup_fail_' + todayStr()); } catch (e3) { /* ignore */ }
    throw new AppError('BACKUP_FAILED', ERR.BACKUP_FAILED + ': ' + (e.message || e));
  }
}

/** Trashes backups older than BACKUP_RETENTION_DAYS (0 = keep all). */
function cleanupOldBackups_() {
  var days = cfgInt('BACKUP_RETENTION_DAYS', 0);
  if (days <= 0) return 0;
  var cutoff = new Date(Date.now() - days * 86400000);
  var removed = 0;
  var years = getBackupRoot_().getFolders();
  while (years.hasNext()) {
    var months = years.next().getFolders();
    while (months.hasNext()) {
      var files = months.next().getFiles();
      while (files.hasNext()) {
        var f = files.next();
        if (f.getName().indexOf('FoodFactory-DB_') === 0 && f.getDateCreated() < cutoff) { f.setTrashed(true); removed++; }
      }
    }
  }
  if (removed) systemLog('INFO', 'BACKUP', 'RETENTION', 'ลบไฟล์ Backup เก่า ' + removed + ' ไฟล์');
  return removed;
}

/** Lists recent backups (current + previous month). */
function listBackups(user) {
  var root = getBackupRoot_();
  var out = [];
  var now = new Date();
  var prev = new Date(now.getTime() - 32 * 86400000);
  [now, prev].forEach(function (d) {
    var y = root.getFoldersByName(formatDate(d, 'yyyy'));
    if (!y.hasNext()) return;
    var m = y.next().getFoldersByName(formatDate(d, 'MM'));
    if (!m.hasNext()) return;
    var files = m.next().getFiles();
    while (files.hasNext()) {
      var f = files.next();
      out.push({ name: f.getName(), url: f.getUrl(), created_at: formatDate(f.getDateCreated()), size: f.getSize() });
    }
  });
  var seen = {};
  out = out.filter(function (f) { if (seen[f.url]) return false; seen[f.url] = true; return true; });
  out.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  return {
    rows: out.slice(0, 60),
    folderUrl: root.getUrl(),
    enabled: cfgBool('BACKUP_ENABLED'),
    hour: cfgInt('BACKUP_HOUR', 18),
    retentionDays: cfgInt('BACKUP_RETENTION_DAYS', 0)
  };
}

/** Admin "Backup now" button. */
function backupNow(user) {
  var info = runBackup('MANUAL');
  writeAudit(user, 'BACKUP_NOW', 'BACKUP', info.fileId, '', info.name);
  return info;
}

/**
 * Archive support: copies all orders (and related rows) of a year into a new
 * spreadsheet "FoodFactory-Archive-<year>" inside the backup folder, then
 * removes those rows from the live sheets. Run manually from the editor:
 *   archiveOrdersByYear(2025)
 * A full backup is always taken first. Current year cannot be archived.
 * @param {number} year
 */
function archiveOrdersByYear(year) {
  year = toInt(year, 0);
  assert(year >= 2000 && year < toInt(formatDate(new Date(), 'yyyy')), 'VALIDATION_ERROR', 'ปีที่ Archive ต้องเป็นปีที่ผ่านมาแล้ว');
  runBackup('PRE_ARCHIVE');
  var prefix = String(year) + '-';
  return withLock(function () {
    var orders = dbAll('ORDERS').filter(function (o) { return String(o.order_date).indexOf(prefix) === 0; });
    if (!orders.length) return { archived: 0 };
    var ids = {};
    orders.forEach(function (o) { ids[o.order_id] = true; });
    var sets = {
      ORDERS: orders,
      ORDER_ITEMS: dbAll('ORDER_ITEMS').filter(function (r) { return ids[r.order_id]; }),
      ORDER_STATUS_LOG: dbAll('ORDER_STATUS_LOG').filter(function (r) { return ids[r.order_id]; }),
      PAYMENT: dbAll('PAYMENT').filter(function (r) { return ids[r.order_id]; })
    };
    var name = 'FoodFactory-Archive-' + year;
    var archive = SpreadsheetApp.create(name);
    DriveApp.getFileById(archive.getId()).moveTo(getBackupRoot_());
    Object.keys(sets).forEach(function (key) {
      var def = SCHEMA[key];
      var sh = archive.insertSheet(def.name);
      var values = [def.columns].concat(sets[key].map(function (r) { return def.columns.map(function (c) { return r[c]; }); }));
      sh.getRange(1, 1, values.length, def.columns.length).setNumberFormat('@').setValues(values);
    });
    var first = archive.getSheetByName('Sheet1') || archive.getSheets()[0];
    if (first && archive.getSheets().length > 1 && Object.keys(sets).map(function (k) { return SCHEMA[k].name; }).indexOf(first.getName()) < 0) archive.deleteSheet(first);
    Object.keys(sets).forEach(function (key) {
      dbDeleteRows(key, sets[key].map(function (r) { return r._row; }));
    });
    systemLog('INFO', 'ARCHIVE', 'ARCHIVE_YEAR', 'Archive ปี ' + year + ': ' + orders.length + ' orders', { url: archive.getUrl() });
    return { archived: orders.length, url: archive.getUrl() };
  });
}

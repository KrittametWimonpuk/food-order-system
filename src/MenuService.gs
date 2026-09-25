/**
 * MenuService.gs
 * ---------------------------------------------------------------------------
 * Menu Master (05_MENU_ITEMS) and Daily Menu (06_DAILY_MENU).
 * Daily menu rows carry their own price / stock per window, so changing the
 * master never alters past days. Orders snapshot name + price again.
 */

var MENU_CACHE_KEY = 'menu_master_v1';
var DAILY_STATUS = ['AVAILABLE', 'SOLD_OUT', 'DISABLED', 'REMOVED'];

/** Active (non-deleted) menu master rows, cached. */
function getMenuMaster() {
  var cached = cacheGet(MENU_CACHE_KEY);
  if (cached) return cached;
  var rows = stripInternal(dbAll('MENU_ITEMS').filter(function (m) { return !toBool(m.is_deleted); }));
  rows.sort(menuSorter_);
  cachePut(MENU_CACHE_KEY, rows, 600);
  return rows;
}

function menuSorter_(a, b) {
  var d = toInt(a.sort_order) - toInt(b.sort_order);
  if (d) return d;
  return String(a.code) < String(b.code) ? -1 : 1;
}

function invalidateMenuCache() { cacheRemove(MENU_CACHE_KEY); }

/** Validates an image URL (https only) or Drive file id. */
function sanitizeImageUrl(u) {
  var s = String(u || '').trim();
  if (!s) return '';
  assert(/^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 500, 'VALIDATION_ERROR', 'URL รูปภาพต้องขึ้นต้นด้วย https://');
  return s;
}

/**
 * Lists menu master items with "sold today" counts.
 * @param {{includeDeleted:boolean, q:string}} p
 */
function listMenuItems(user, p) {
  p = p || {};
  var items = dbAll('MENU_ITEMS').filter(function (m) { return p.includeDeleted || !toBool(m.is_deleted); });
  var today = todayStr();
  var soldToday = {};
  dbFind('DAILY_MENU', 'date', today).forEach(function (d) {
    if (d.status === 'REMOVED') return;
    var s = soldToday[d.item_id] = soldToday[d.item_id] || { sold: 0, stock: 0 };
    s.sold += toInt(d.sold_qty); s.stock += toInt(d.stock_limit);
  });
  var q = String(p.q || '').trim().toLowerCase();
  var rows = items.filter(function (m) {
    return !q || (m.code + ' ' + m.name + ' ' + m.category).toLowerCase().indexOf(q) >= 0;
  }).map(function (m) {
    var o = stripInternal(m);
    o.is_deleted = toBool(m.is_deleted);
    o.sold_today = soldToday[m.item_id] ? soldToday[m.item_id].sold : 0;
    o.stock_today = soldToday[m.item_id] ? soldToday[m.item_id].stock : 0;
    return o;
  });
  rows.sort(menuSorter_);
  return { rows: rows, categories: cfgList('MENU_CATEGORIES') };
}

/** Next free code F001, F002, ... */
function nextMenuCode_() {
  var max = 0;
  dbAll('MENU_ITEMS').forEach(function (m) {
    var mm = String(m.code).match(/^F(\d+)$/);
    if (mm) max = Math.max(max, parseInt(mm[1], 10));
  });
  return 'F' + pad(max + 1, 3);
}

/**
 * Creates or updates a menu master item.
 * @param {{item_id?, code?, name, description, category, default_price, default_stock, max_per_order, image_url, status, sort_order}} p
 */
function saveMenuItem(user, p) {
  p = p || {};
  var name = sanitizeText(p.name, 100);
  assert(name.length >= 2, 'VALIDATION_ERROR', 'กรุณากรอกชื่อเมนู');
  var price = toNum(p.default_price, NaN);
  assert(isFinite(price) && price >= 0 && price <= 10000, 'VALIDATION_ERROR', 'ราคาไม่ถูกต้อง');
  var stock = toInt(p.default_stock, NaN);
  assert(isFinite(stock) && stock >= 0 && stock <= 100000, 'VALIDATION_ERROR', 'จำนวนสูงสุดไม่ถูกต้อง');
  var maxPer = toInt(p.max_per_order, 0);
  assert(maxPer >= 0 && maxPer <= 100, 'VALIDATION_ERROR', 'จำนวนสูงสุดต่อ Order ไม่ถูกต้อง');
  var status = String(p.status || 'ACTIVE').toUpperCase();
  assert(status === 'ACTIVE' || status === 'INACTIVE', 'VALIDATION_ERROR', 'สถานะไม่ถูกต้อง');
  var fields = {
    name: name,
    description: sanitizeText(p.description, 300),
    category: sanitizeText(p.category, 50),
    default_price: roundMoney(price),
    default_stock: stock,
    max_per_order: maxPer,
    image_url: sanitizeImageUrl(p.image_url),
    status: status,
    sort_order: toInt(p.sort_order, 0)
  };
  var res = withLock(function () {
    var now = nowStr();
    var code = String(p.code || '').trim().toUpperCase();
    if (code) assert(/^[A-Z0-9_\-]{1,20}$/.test(code), 'VALIDATION_ERROR', 'รหัสเมนูไม่ถูกต้อง');
    var all = dbAll('MENU_ITEMS');
    if (p.item_id) {
      var item = all.filter(function (m) { return m.item_id === String(p.item_id); })[0];
      assert(item, 'MENU_NOT_FOUND');
      if (code && code !== item.code) {
        assert(!all.some(function (m) { return m.code === code; }), 'DUPLICATE_CODE', 'รหัสเมนูซ้ำ');
        fields.code = code;
      }
      fields.updated_at = now;
      var d = diffFields(item, fields, Object.keys(fields).filter(function (k) { return k !== 'updated_at'; }));
      dbUpdate('MENU_ITEMS', item, fields);
      if (d.changed) writeAudit(user, 'UPDATE_MENU', 'MENU', item.code, d.old, d.new);
      return item;
    }
    if (!code) code = nextMenuCode_();
    assert(!all.some(function (m) { return m.code === code; }), 'DUPLICATE_CODE', 'รหัสเมนูซ้ำ');
    fields.item_id = uuid();
    fields.code = code;
    fields.is_deleted = 'FALSE';
    fields.created_at = now;
    fields.updated_at = now;
    fields.is_sample = 'FALSE';
    var row = dbInsert('MENU_ITEMS', fields);
    writeAudit(user, 'CREATE_MENU', 'MENU', code, '', { name: name, price: fields.default_price, stock: stock });
    return row;
  });
  invalidateMenuCache();
  return { item: stripInternal(res) };
}

/** Enables / disables a menu master item. */
function toggleMenuItem(user, p) {
  var status = String(p && p.status || '').toUpperCase();
  assert(status === 'ACTIVE' || status === 'INACTIVE', 'VALIDATION_ERROR', 'สถานะไม่ถูกต้อง');
  var item = dbFindOne('MENU_ITEMS', 'item_id', String(p.item_id || ''));
  assert(item && !toBool(item.is_deleted), 'MENU_NOT_FOUND');
  var old = item.status;
  dbUpdate('MENU_ITEMS', item, { status: status, updated_at: nowStr() });
  invalidateMenuCache();
  writeAudit(user, 'TOGGLE_MENU', 'MENU', item.code, old, status);
  return { item: stripInternal(item) };
}

/** Soft-deletes a menu master item. */
function deleteMenuItem(user, p) {
  var item = dbFindOne('MENU_ITEMS', 'item_id', String(p && p.item_id || ''));
  assert(item && !toBool(item.is_deleted), 'MENU_NOT_FOUND');
  dbUpdate('MENU_ITEMS', item, { is_deleted: 'TRUE', status: 'INACTIVE', updated_at: nowStr() });
  invalidateMenuCache();
  writeAudit(user, 'DELETE_MENU', 'MENU', item.code, item.name, 'is_deleted=TRUE');
  return { deleted: true };
}

/** Restores a soft-deleted menu master item. */
function restoreMenuItem(user, p) {
  var item = dbFindOne('MENU_ITEMS', 'item_id', String(p && p.item_id || ''));
  assert(item, 'MENU_NOT_FOUND');
  dbUpdate('MENU_ITEMS', item, { is_deleted: 'FALSE', status: 'INACTIVE', updated_at: nowStr() });
  invalidateMenuCache();
  writeAudit(user, 'RESTORE_MENU', 'MENU', item.code, 'is_deleted=TRUE', 'is_deleted=FALSE');
  return { item: stripInternal(item) };
}

/**
 * Uploads a menu image to Drive and returns a public thumbnail URL.
 * @param {{fileName:string, mimeType:string, data:string(base64)}} p
 */
function uploadMenuImage(user, p) {
  p = p || {};
  var mime = String(p.mimeType || '');
  assert(/^image\/(png|jpeg|jpg|webp|gif)$/.test(mime), 'VALIDATION_ERROR', 'รองรับเฉพาะไฟล์รูป PNG/JPG/WEBP/GIF');
  var data = String(p.data || '');
  assert(data.length > 0 && data.length <= 2800000, 'VALIDATION_ERROR', 'ขนาดไฟล์ต้องไม่เกิน 2MB');
  var bytes = Utilities.base64Decode(data);
  var name = 'menu_' + formatDate(new Date(), 'yyyyMMdd_HHmmss') + '_' + sanitizeText(p.fileName, 60).replace(/[^\w.\-]/g, '_');
  var folder = getOrCreateFolderByProp_(PROP.IMAGE_FOLDER_ID, 'FoodFactory-Images');
  var file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  var shared = true;
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    shared = false;
    logError(e, 'MENU', 'uploadMenuImage.setSharing');
  }
  var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800';
  writeAudit(user, 'UPLOAD_MENU_IMAGE', 'MENU', file.getId(), '', name);
  return { url: url, fileId: file.getId(), shared: shared };
}

/* ------------------------------------------------------------------------- */
/* Daily menu                                                                 */
/* ------------------------------------------------------------------------- */

/** Daily menu rows of a window (excluding REMOVED), sorted. */
function getDailyMenuRows(windowId) {
  return dbFind('DAILY_MENU', 'window_id', windowId).filter(function (d) { return d.status !== 'REMOVED'; })
    .sort(menuSorter_);
}

/** Client representation of a daily menu row. */
function dailyMenuToClient(d, masterById) {
  var m = masterById ? masterById[d.item_id] : null;
  var remaining = Math.max(0, toInt(d.stock_limit) - toInt(d.sold_qty));
  var status = d.status;
  if (status === 'AVAILABLE' && remaining <= 0) status = 'SOLD_OUT';
  return {
    daily_menu_id: d.daily_menu_id,
    window_id: d.window_id,
    item_id: d.item_id,
    name: d.item_name,
    description: m ? m.description : '',
    category: m ? m.category : '',
    image_url: m ? m.image_url : '',
    code: m ? m.code : '',
    price: toNum(d.price),
    stock_limit: toInt(d.stock_limit),
    sold_qty: toInt(d.sold_qty),
    remaining: remaining,
    max_per_order: toInt(d.max_per_order),
    status: status,
    stored_status: d.status,
    sort_order: toInt(d.sort_order)
  };
}

/** Copies all ACTIVE master items into a window's daily menu (caller holds lock). */
function copyMasterToDailyMenu_(w) {
  var existing = {};
  dbFind('DAILY_MENU', 'window_id', w.window_id).forEach(function (d) { existing[d.item_id] = true; });
  var now = nowStr();
  var rows = dbAll('MENU_ITEMS').filter(function (m) {
    return m.status === 'ACTIVE' && !toBool(m.is_deleted) && !existing[m.item_id];
  }).map(function (m) {
    return newDailyRow_(w, m, now);
  });
  dbInsertMany('DAILY_MENU', rows);
  return rows.length;
}

function newDailyRow_(w, m, now, overrides) {
  overrides = overrides || {};
  return {
    daily_menu_id: uuid(),
    window_id: w.window_id,
    date: w.date,
    meal: w.meal,
    item_id: m.item_id,
    item_name: m.name,
    price: overrides.price !== undefined ? overrides.price : toNum(m.default_price),
    stock_limit: overrides.stock_limit !== undefined ? overrides.stock_limit : toInt(m.default_stock),
    sold_qty: 0,
    max_per_order: toInt(m.max_per_order),
    status: 'AVAILABLE',
    sort_order: toInt(m.sort_order),
    created_at: now,
    updated_at: now,
    is_sample: toBool(w.is_sample) ? 'TRUE' : 'FALSE'
  };
}

/**
 * Lists the daily menu of a window (admin/kitchen view).
 * @param {{window_id:string}} p
 */
function listDailyMenu(user, p) {
  var w = getWindowById(p && p.window_id);
  var master = indexBy(getMenuMaster(), 'item_id');
  var rows = getDailyMenuRows(w.window_id).map(function (d) { return dailyMenuToClient(d, master); });
  var used = {};
  rows.forEach(function (r) { used[r.item_id] = true; });
  var available = getMenuMaster().filter(function (m) { return m.status === 'ACTIVE' && !used[m.item_id]; })
    .map(function (m) { return { item_id: m.item_id, code: m.code, name: m.name, default_price: m.default_price, default_stock: m.default_stock }; });
  return { window: windowToClient(w), rows: rows, available: available };
}

/**
 * Adds master items to a window's daily menu.
 * @param {{window_id:string, item_ids:string[]}} p
 */
function addDailyMenuItems(user, p) {
  p = p || {};
  var ids = Array.isArray(p.item_ids) ? p.item_ids.map(String) : [];
  assert(ids.length > 0 && ids.length <= 100, 'VALIDATION_ERROR', 'กรุณาเลือกเมนู');
  var added = withLock(function () {
    var w = getWindowById(p.window_id);
    assert(w.status !== WINDOW_STATUS.COMPLETED, 'VALIDATION_ERROR', 'มื้อนี้จบแล้ว');
    var existing = {};
    dbFind('DAILY_MENU', 'window_id', w.window_id).forEach(function (d) { existing[d.item_id] = d; });
    var master = indexBy(dbAll('MENU_ITEMS'), 'item_id');
    var now = nowStr();
    var inserts = [], revive = [];
    ids.forEach(function (id) {
      var m = master[id];
      assert(m && !toBool(m.is_deleted), 'MENU_NOT_FOUND');
      if (existing[id]) {
        if (existing[id].status === 'REMOVED') revive.push({ row: existing[id], changes: { status: 'AVAILABLE', updated_at: now } });
        return;
      }
      inserts.push(newDailyRow_(w, m, now));
    });
    dbInsertMany('DAILY_MENU', inserts);
    if (revive.length) dbUpdateMany('DAILY_MENU', revive);
    writeAudit(user, 'ADD_DAILY_MENU', 'DAILY_MENU', w.window_id, '', ids);
    return inserts.length + revive.length;
  });
  return { added: added };
}

/**
 * Updates price / stock / max per order / status of a daily menu row.
 * Stock can't go below what is already sold.
 * @param {{daily_menu_id, price, stock_limit, max_per_order, status}} p
 */
function saveDailyMenu(user, p) {
  p = p || {};
  return withLock(function () {
    var d = dbFindOne('DAILY_MENU', 'daily_menu_id', String(p.daily_menu_id || ''));
    assert(d && d.status !== 'REMOVED', 'MENU_NOT_FOUND');
    var changes = { updated_at: nowStr() };
    var isAdmin = user.role === ROLE.ADMIN;
    if (isAdmin && p.price !== undefined) {
      var price = toNum(p.price, NaN);
      assert(isFinite(price) && price >= 0 && price <= 10000, 'VALIDATION_ERROR', 'ราคาไม่ถูกต้อง');
      changes.price = roundMoney(price);
    }
    if (isAdmin && p.stock_limit !== undefined) {
      var stock = toInt(p.stock_limit, NaN);
      assert(isFinite(stock) && stock >= 0 && stock <= 100000, 'VALIDATION_ERROR', 'จำนวนไม่ถูกต้อง');
      assert(stock >= toInt(d.sold_qty), 'VALIDATION_ERROR', 'จำนวนต้องไม่น้อยกว่าที่ขายไปแล้ว (' + d.sold_qty + ')');
      changes.stock_limit = stock;
    }
    if (isAdmin && p.max_per_order !== undefined) {
      var mx = toInt(p.max_per_order, NaN);
      assert(isFinite(mx) && mx >= 0 && mx <= 100, 'VALIDATION_ERROR', 'จำนวนสูงสุดต่อ Order ไม่ถูกต้อง');
      changes.max_per_order = mx;
    }
    if (p.status !== undefined) {
      var st = String(p.status).toUpperCase();
      assert(['AVAILABLE', 'SOLD_OUT', 'DISABLED'].indexOf(st) >= 0, 'VALIDATION_ERROR', 'สถานะไม่ถูกต้อง');
      changes.status = st;
    }
    var diff = diffFields(d, changes, ['price', 'stock_limit', 'max_per_order', 'status']);
    dbUpdate('DAILY_MENU', d, changes);
    if (diff.changed) writeAudit(user, 'UPDATE_DAILY_MENU', 'DAILY_MENU', d.item_name + ' ' + d.date, diff.old, diff.new);
    return { row: dailyMenuToClient(d, indexBy(getMenuMaster(), 'item_id')) };
  });
}

/** Removes a daily menu row (soft). Rows with sales are disabled instead. */
function removeDailyMenu(user, p) {
  return withLock(function () {
    var d = dbFindOne('DAILY_MENU', 'daily_menu_id', String(p && p.daily_menu_id || ''));
    assert(d && d.status !== 'REMOVED', 'MENU_NOT_FOUND');
    var st = toInt(d.sold_qty) > 0 ? 'DISABLED' : 'REMOVED';
    dbUpdate('DAILY_MENU', d, { status: st, updated_at: nowStr() });
    writeAudit(user, 'REMOVE_DAILY_MENU', 'DAILY_MENU', d.item_name + ' ' + d.date, '', st);
    return { status: st };
  });
}

/** Copies all active master items into the window (skips existing). */
function copyDefaultsToDailyMenu(user, p) {
  var n = withLock(function () {
    var w = getWindowById(p && p.window_id);
    assert(w.status !== WINDOW_STATUS.COMPLETED, 'VALIDATION_ERROR', 'มื้อนี้จบแล้ว');
    return copyMasterToDailyMenu_(w);
  });
  writeAudit(user, 'COPY_DAILY_MENU', 'DAILY_MENU', p.window_id, '', n + ' items');
  return { added: n };
}

/**
 * Recalculates sold_qty of a window's daily menu from active order items.
 * Repairs counters after manual sheet edits.
 */
function recalcDailyStock(user, p) {
  return withLock(function () {
    var w = getWindowById(p && p.window_id);
    var activeOrders = {};
    dbFind('ORDERS', 'window_id', w.window_id).forEach(function (o) {
      if (ACTIVE_ORDER_STATUSES.indexOf(o.status) >= 0) activeOrders[o.order_id] = true;
    });
    var sold = {};
    dbFind('ORDER_ITEMS', 'window_id', w.window_id).forEach(function (it) {
      if (it.status === 'ACTIVE' && activeOrders[it.order_id]) sold[it.daily_menu_id] = (sold[it.daily_menu_id] || 0) + toInt(it.qty);
    });
    var updates = [];
    dbFind('DAILY_MENU', 'window_id', w.window_id).forEach(function (d) {
      var s = sold[d.daily_menu_id] || 0;
      if (s !== toInt(d.sold_qty)) updates.push({ row: d, changes: { sold_qty: s, updated_at: nowStr() } });
    });
    dbUpdateMany('DAILY_MENU', updates);
    writeAudit(user, 'RECALC_STOCK', 'DAILY_MENU', w.window_id, '', updates.length + ' rows fixed');
    return { fixed: updates.length };
  });
}

/** Returns (creating if needed) a Drive folder whose id is kept in a Script Property. */
function getOrCreateFolderByProp_(propKey, name) {
  var id = getScriptProp(propKey);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  setScriptProp(propKey, folder.getId());
  return folder;
}

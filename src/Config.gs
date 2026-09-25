/**
 * Config.gs
 * ---------------------------------------------------------------------------
 * Global constants: sheet schema, roles, statuses, error codes and default
 * configuration values. Everything that is "data about the system" lives here
 * so services never hardcode sheet names or column orders.
 */

/** Application meta. */
var APP = Object.freeze({
  NAME: 'Factory Food Ordering System',
  VERSION: '1.0.0',
  TIMEZONE: 'Asia/Bangkok',
  TZ_OFFSET: '+07:00',
  LOCK_TIMEOUT_MS: 20000,
  CACHE_TTL_SEC: 600
});

/** Script Property keys (secrets are NEVER stored in source code). */
var PROP = Object.freeze({
  DATABASE_SHEET_ID: 'DATABASE_SHEET_ID',
  APP_SECRET: 'APP_SECRET',
  PIN_SALT: 'PIN_SALT',
  LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN',
  LINE_CHANNEL_SECRET: 'LINE_CHANNEL_SECRET',
  LINE_TARGET_ID: 'LINE_TARGET_ID',
  BACKUP_FOLDER_ID: 'BACKUP_FOLDER_ID',
  IMAGE_FOLDER_ID: 'IMAGE_FOLDER_ID',
  EXPORT_FOLDER_ID: 'EXPORT_FOLDER_ID',
  BASE_URL: 'BASE_URL'
});

/** Roles. */
var ROLE = Object.freeze({
  EMPLOYEE: 'EMPLOYEE',
  KITCHEN: 'KITCHEN',
  ADMIN: 'ADMIN',
  VIEWER: 'VIEWER'
});
var ALL_ROLES = [ROLE.EMPLOYEE, ROLE.KITCHEN, ROLE.ADMIN, ROLE.VIEWER];

/** Order status. */
var ORDER_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  PICKED_UP: 'PICKED_UP',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW'
});

/** Statuses that still count against stock / as an active order. */
var ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP', 'NO_SHOW'];

/**
 * Allowed order status transitions per role.
 * Employee transitions are handled by OrderService.cancelOrder (CONFIRMED -> CANCELLED only).
 */
var ORDER_TRANSITIONS = Object.freeze({
  KITCHEN: {
    CONFIRMED: ['PREPARING', 'READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW'],
    PREPARING: ['READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW'],
    READY: ['PICKED_UP', 'NO_SHOW', 'PREPARING'],
    NO_SHOW: ['PICKED_UP'],
    PICKED_UP: [],
    CANCELLED: []
  },
  ADMIN: {
    CONFIRMED: ['PREPARING', 'READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW'],
    PREPARING: ['CONFIRMED', 'READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW'],
    READY: ['PREPARING', 'PICKED_UP', 'NO_SHOW', 'CANCELLED'],
    NO_SHOW: ['PICKED_UP', 'READY'],
    PICKED_UP: ['READY'],
    CANCELLED: []
  }
});

/** Meal types. */
var MEAL = Object.freeze({ BREAKFAST: 'BREAKFAST', LUNCH: 'LUNCH', DINNER: 'DINNER' });
var MEAL_TYPES = ['BREAKFAST', 'LUNCH', 'DINNER'];
var MEAL_LABEL_TH = Object.freeze({ BREAKFAST: 'มื้อเช้า', LUNCH: 'มื้อกลางวัน', DINNER: 'มื้อเย็น' });

/** Meal window status. */
var WINDOW_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  PREPARING: 'PREPARING',
  COMPLETED: 'COMPLETED'
});
var WINDOW_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'PREPARING', 'COMPLETED'];

/** Notification queue. */
var NOTI_STATUS = Object.freeze({
  PENDING: 'PENDING', PROCESSING: 'PROCESSING', SENT: 'SENT', FAILED: 'FAILED', RETRY: 'RETRY'
});
var NOTI_TYPE = Object.freeze({
  ORDER_INSTANT: 'ORDER_INSTANT',
  ORDER_SUMMARY: 'ORDER_SUMMARY',
  FINAL_SUMMARY: 'FINAL_SUMMARY',
  SYSTEM_ALERT: 'SYSTEM_ALERT',
  TEST: 'TEST',
  PIN_RESET_REQUEST: 'PIN_RESET_REQUEST'
});
var NOTIFICATION_MODES = ['INSTANT', 'SUMMARY', 'CUTOFF'];
var MAX_NOTIFICATION_RETRY = 3;

/** Error codes -> default Thai message. */
var ERR = Object.freeze({
  AUTH_INVALID: 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง',
  AUTH_LOCKED: 'บัญชีถูกล็อกชั่วคราวเนื่องจากใส่ PIN ผิดหลายครั้ง',
  AUTH_RATE_LIMIT: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่',
  EMPLOYEE_DISABLED: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
  PIN_CHANGE_REQUIRED: 'กรุณาเปลี่ยน PIN ก่อนใช้งาน',
  SESSION_EXPIRED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  ACCESS_DENIED: 'คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้',
  VALIDATION_ERROR: 'ข้อมูลไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบข้อมูล',
  MEAL_NOT_FOUND: 'ไม่พบมื้ออาหาร',
  MEAL_NOT_OPEN: 'ยังไม่เปิดรับการสั่งอาหาร',
  MEAL_CLOSED: 'ปิดรับการสั่งอาหารแล้ว',
  MENU_NOT_FOUND: 'ไม่พบเมนูอาหาร',
  MENU_SOLD_OUT: 'เมนูนี้หมดแล้ว',
  INVALID_QTY: 'จำนวนไม่ถูกต้อง',
  INVALID_STATUS: 'ไม่สามารถเปลี่ยนสถานะนี้ได้',
  ORDER_NOT_FOUND: 'ไม่พบรายการสั่งอาหาร',
  ORDER_EXISTS: 'คุณมีรายการสั่งอาหารในมื้อนี้แล้ว กรุณาแก้ไขรายการเดิม',
  ORDER_ALREADY_CANCELLED: 'รายการนี้ถูกยกเลิกแล้ว',
  ORDER_ALREADY_PICKED_UP: 'รายการนี้รับอาหารไปแล้ว',
  ORDER_NOT_EDITABLE: 'ไม่สามารถแก้ไขรายการนี้ได้',
  DUPLICATE_REQUEST: 'คำขอซ้ำ',
  DUPLICATE_CODE: 'รหัสนี้มีอยู่แล้วในระบบ',
  PRICE_CHANGED: 'ราคาอาหารมีการเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง',
  LINE_NOT_CONFIGURED: 'ยังไม่ได้ตั้งค่า LINE Messaging API',
  LINE_SEND_FAILED: 'ส่งข้อความ LINE ไม่สำเร็จ',
  LOCK_TIMEOUT: 'ระบบกำลังประมวลผลคำขอจำนวนมาก กรุณาลองใหม่อีกครั้ง',
  SETUP_REQUIRED: 'ระบบยังไม่ได้ตั้งค่าฐานข้อมูล',
  BACKUP_FAILED: 'สำรองข้อมูลไม่สำเร็จ',
  DB_ERROR: 'เกิดข้อผิดพลาดของฐานข้อมูล',
  UNKNOWN_ACTION: 'ไม่พบคำสั่งที่ร้องขอ',
  INTERNAL_ERROR: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง'
});

/**
 * Database schema. Keys are logical table names; `name` is the sheet name.
 * `numeric` columns are stored as numbers; all others are stored as plain text
 * (sheets are formatted '@' so dates/IDs are never auto-converted).
 * New columns may be appended at the end safely - setupDatabase() adds them.
 */
var SCHEMA = {
  CONFIG: {
    name: '01_CONFIG',
    columns: ['key', 'value', 'description', 'updated_at', 'updated_by'],
    numeric: []
  },
  EMPLOYEES: {
    name: '02_EMPLOYEES',
    columns: ['employee_id', 'employee_code', 'name', 'department', 'role', 'pin_hash', 'status',
      'must_change_pin', 'failed_attempts', 'locked_until', 'created_at', 'updated_at', 'last_login',
      'is_sample'],
    numeric: ['failed_attempts']
  },
  SESSIONS: {
    name: '03_USER_SESSIONS',
    columns: ['session_id', 'session_token', 'employee_id', 'role', 'created_at', 'expires_at',
      'last_activity', 'revoked', 'remember', 'user_agent'],
    numeric: []
  },
  MEAL_WINDOWS: {
    name: '04_MEAL_WINDOWS',
    columns: ['window_id', 'date', 'meal', 'open_at', 'close_at', 'pickup_start', 'pickup_end',
      'status', 'auto', 'note', 'last_summary_at', 'final_sent_at', 'created_at', 'updated_at',
      'created_by', 'is_sample'],
    numeric: []
  },
  MENU_ITEMS: {
    name: '05_MENU_ITEMS',
    columns: ['item_id', 'code', 'name', 'description', 'category', 'default_price', 'default_stock',
      'max_per_order', 'image_url', 'status', 'is_deleted', 'sort_order', 'created_at', 'updated_at',
      'is_sample'],
    numeric: ['default_price', 'default_stock', 'max_per_order', 'sort_order']
  },
  DAILY_MENU: {
    name: '06_DAILY_MENU',
    columns: ['daily_menu_id', 'window_id', 'date', 'meal', 'item_id', 'item_name', 'price',
      'stock_limit', 'sold_qty', 'max_per_order', 'status', 'sort_order', 'created_at', 'updated_at',
      'is_sample'],
    numeric: ['price', 'stock_limit', 'sold_qty', 'max_per_order', 'sort_order']
  },
  ORDERS: {
    name: '07_ORDERS',
    columns: ['order_id', 'order_no', 'employee_id', 'employee_code', 'employee_name', 'department',
      'window_id', 'order_date', 'meal', 'status', 'total_qty', 'total_amount', 'items_json', 'note',
      'request_token', 'created_at', 'updated_at', 'cancelled_at', 'cancelled_by', 'picked_up_at',
      'picked_up_by', 'version', 'is_sample'],
    numeric: ['total_qty', 'total_amount', 'version']
  },
  ORDER_ITEMS: {
    name: '08_ORDER_ITEMS',
    columns: ['order_item_id', 'order_id', 'window_id', 'daily_menu_id', 'item_id',
      'item_name_snapshot', 'qty', 'unit_price', 'subtotal', 'item_note', 'status', 'created_at',
      'is_sample'],
    numeric: ['qty', 'unit_price', 'subtotal']
  },
  ORDER_STATUS_LOG: {
    name: '09_ORDER_STATUS_LOG',
    columns: ['log_id', 'order_id', 'order_no', 'from_status', 'to_status', 'changed_by',
      'changed_by_role', 'reason', 'created_at'],
    numeric: []
  },
  NOTIFICATION_QUEUE: {
    name: '10_NOTIFICATION_QUEUE',
    columns: ['notification_id', 'type', 'recipient', 'payload', 'status', 'retry_count',
      'created_at', 'sent_at', 'last_error', 'next_retry_at', 'dedupe_key'],
    numeric: ['retry_count']
  },
  AUDIT_LOG: {
    name: '11_AUDIT_LOG',
    columns: ['audit_id', 'timestamp', 'user_id', 'user_code', 'role', 'action', 'module',
      'target_id', 'old_value', 'new_value', 'request_id'],
    numeric: []
  },
  PAYMENT: {
    name: '12_PAYMENT',
    columns: ['payment_id', 'order_id', 'order_no', 'employee_id', 'employee_code', 'amount',
      'method', 'status', 'period', 'created_at', 'updated_at', 'is_sample'],
    numeric: ['amount']
  },
  DAILY_SUMMARY: {
    name: '13_DAILY_SUMMARY',
    columns: ['summary_id', 'date', 'meal', 'window_id', 'total_orders', 'total_qty', 'total_amount',
      'cancelled', 'picked_up', 'no_show', 'created_at', 'updated_at'],
    numeric: ['total_orders', 'total_qty', 'total_amount', 'cancelled', 'picked_up', 'no_show']
  },
  ERROR_LOG: {
    name: '14_ERROR_LOG',
    columns: ['error_id', 'timestamp', 'request_id', 'module', 'function_name', 'user_id',
      'error_code', 'error_message', 'stack'],
    numeric: []
  },
  SYSTEM_LOG: {
    name: '15_SYSTEM_LOG',
    columns: ['log_id', 'timestamp', 'level', 'module', 'event', 'message', 'data'],
    numeric: []
  }
};

/**
 * Default configuration rows written by setupDatabase() when missing.
 * Existing values are never overwritten.
 */
var DEFAULT_CONFIG = [
  ['COMPANY_NAME', 'โรงงาน ABC', 'ชื่อบริษัท/โรงงาน ที่แสดงในระบบ'],
  ['TIMEZONE', 'Asia/Bangkok', 'Timezone ของระบบ (อ่านอย่างเดียว)'],
  ['MAX_QTY_PER_ORDER', '0', 'จำนวนกล่องสูงสุดต่อ 1 Order (0 = ไม่จำกัด)'],
  ['ALLOW_EDIT', 'TRUE', 'อนุญาตให้พนักงานแก้ไข Order ก่อนปิดรอบ'],
  ['ALLOW_CANCEL', 'TRUE', 'อนุญาตให้พนักงานยกเลิก Order ก่อนปิดรอบ'],
  ['ALLOW_MULTIPLE_ORDERS', 'TRUE', 'อนุญาตให้พนักงาน 1 คนสั่งได้หลาย Order ต่อมื้อ'],
  ['DEFAULT_MEALS', 'LUNCH', 'มื้อที่สร้างอัตโนมัติทุกวัน (คั่นด้วย , เช่น LUNCH,DINNER)'],
  ['AUTO_CREATE_WINDOW', 'TRUE', 'สร้างมื้ออาหารของวันอัตโนมัติ'],
  ['AUTO_DAILY_MENU', 'TRUE', 'ใส่เมนูที่เปิดใช้งานทั้งหมดเข้า Daily Menu อัตโนมัติเมื่อสร้างมื้อ'],
  ['WORKING_DAYS', '1,2,3,4,5,6', 'วันทำงานที่สร้างมื้ออัตโนมัติ (0=อาทิตย์ ... 6=เสาร์)'],
  ['LUNCH_OPEN_TIME', '08:00', 'เวลาเปิดรับจอง มื้อกลางวัน'],
  ['LUNCH_CLOSE_TIME', '10:30', 'เวลาปิดรับจอง มื้อกลางวัน'],
  ['LUNCH_PICKUP_START', '11:30', 'เวลาเริ่มรับอาหาร มื้อกลางวัน'],
  ['LUNCH_PICKUP_END', '13:00', 'เวลาสิ้นสุดรับอาหาร มื้อกลางวัน'],
  ['BREAKFAST_OPEN_TIME', '05:00', 'เวลาเปิดรับจอง มื้อเช้า'],
  ['BREAKFAST_CLOSE_TIME', '06:30', 'เวลาปิดรับจอง มื้อเช้า'],
  ['BREAKFAST_PICKUP_START', '07:00', 'เวลาเริ่มรับอาหาร มื้อเช้า'],
  ['BREAKFAST_PICKUP_END', '08:30', 'เวลาสิ้นสุดรับอาหาร มื้อเช้า'],
  ['DINNER_OPEN_TIME', '13:00', 'เวลาเปิดรับจอง มื้อเย็น'],
  ['DINNER_CLOSE_TIME', '15:30', 'เวลาปิดรับจอง มื้อเย็น'],
  ['DINNER_PICKUP_START', '17:00', 'เวลาเริ่มรับอาหาร มื้อเย็น'],
  ['DINNER_PICKUP_END', '19:00', 'เวลาสิ้นสุดรับอาหาร มื้อเย็น'],
  ['AUTO_NO_SHOW', 'TRUE', 'เปลี่ยน Order ที่ไม่มารับเป็น NO_SHOW อัตโนมัติเมื่อจบมื้อ'],
  ['LINE_NOTIFICATION_MODE', 'SUMMARY', 'INSTANT | SUMMARY | CUTOFF'],
  ['SUMMARY_INTERVAL_MINUTES', '30', 'ส่งสรุปยอดทุกกี่นาที (โหมด SUMMARY)'],
  ['LINE_ENABLED', 'TRUE', 'เปิด/ปิดการส่ง LINE ทั้งระบบ'],
  ['LINE_WEBHOOK_CAPTURE', 'FALSE', 'บันทึก Group/User ID จาก LINE Webhook ลง System Log (ใช้ตอนตั้งค่า)'],
  ['SCHEDULER_INTERVAL_MINUTES', '5', 'ความถี่ Scheduler (1,5,10,15,30)'],
  ['BACKUP_ENABLED', 'TRUE', 'เปิดสำรองข้อมูลอัตโนมัติรายวัน'],
  ['BACKUP_HOUR', '18', 'ชั่วโมงที่สำรองข้อมูล (0-23)'],
  ['BACKUP_RETENTION_DAYS', '0', 'ลบไฟล์ Backup เก่ากว่ากี่วัน (0 = เก็บทั้งหมด)'],
  ['SESSION_TIMEOUT_MINUTES', '120', 'เซสชันหมดอายุเมื่อไม่มีการใช้งาน (นาที)'],
  ['REMEMBER_DAYS', '30', 'จำการเข้าสู่ระบบบนอุปกรณ์ (วัน)'],
  ['LOGIN_MAX_ATTEMPTS', '5', 'จำนวนครั้งที่ใส่ PIN ผิดได้ก่อนล็อก'],
  ['LOGIN_LOCK_MINUTES', '15', 'ระยะเวลาล็อกบัญชี (นาที)'],
  ['PIN_MIN_LENGTH', '4', 'ความยาว PIN ขั้นต่ำ (ตัวเลข 4-8 หลัก)'],
  ['DEPARTMENTS', 'Production,QA,Warehouse,Maintenance,Office', 'รายชื่อแผนก (คั่นด้วย ,)'],
  ['MENU_CATEGORIES', 'อาหารจานเดียว,กับข้าว,ก๋วยเตี๋ยว,อาหารเจ/มังสวิรัติ,ของหวาน,เครื่องดื่ม', 'หมวดหมู่เมนู'],
  ['PAYMENT_METHOD', 'PAYROLL_DEDUCTION', 'วิธีชำระเงินเริ่มต้น (หักเงินเดือน)']
];

/** Config keys an admin may edit from the Settings page, with validation type. */
var EDITABLE_CONFIG = {
  COMPANY_NAME: 'text', MAX_QTY_PER_ORDER: 'int', ALLOW_EDIT: 'bool', ALLOW_CANCEL: 'bool',
  ALLOW_MULTIPLE_ORDERS: 'bool', DEFAULT_MEALS: 'meals', AUTO_CREATE_WINDOW: 'bool',
  AUTO_DAILY_MENU: 'bool', WORKING_DAYS: 'days',
  LUNCH_OPEN_TIME: 'time', LUNCH_CLOSE_TIME: 'time', LUNCH_PICKUP_START: 'time', LUNCH_PICKUP_END: 'time',
  BREAKFAST_OPEN_TIME: 'time', BREAKFAST_CLOSE_TIME: 'time', BREAKFAST_PICKUP_START: 'time',
  BREAKFAST_PICKUP_END: 'time', DINNER_OPEN_TIME: 'time', DINNER_CLOSE_TIME: 'time',
  DINNER_PICKUP_START: 'time', DINNER_PICKUP_END: 'time', AUTO_NO_SHOW: 'bool',
  LINE_NOTIFICATION_MODE: 'notimode', SUMMARY_INTERVAL_MINUTES: 'int', LINE_ENABLED: 'bool',
  LINE_WEBHOOK_CAPTURE: 'bool', SCHEDULER_INTERVAL_MINUTES: 'interval', BACKUP_ENABLED: 'bool',
  BACKUP_HOUR: 'hour', BACKUP_RETENTION_DAYS: 'int', SESSION_TIMEOUT_MINUTES: 'int',
  REMEMBER_DAYS: 'int', LOGIN_MAX_ATTEMPTS: 'int', LOGIN_LOCK_MINUTES: 'int', PIN_MIN_LENGTH: 'int',
  DEPARTMENTS: 'list',
  MENU_CATEGORIES: 'list', PAYMENT_METHOD: 'text'
};

/* ------------------------------------------------------------------------- */
/* Runtime configuration accessors (01_CONFIG sheet, cached)                  */
/* ------------------------------------------------------------------------- */

var CONFIG_CACHE_KEY = 'cfg_v1';
var CONFIG_MEMO = null;

/**
 * Returns all config values as a {KEY: value} map (cached in CacheService).
 * Falls back to DEFAULT_CONFIG values for missing keys.
 * @return {Object<string,string>}
 */
function getConfigMap() {
  if (CONFIG_MEMO) return CONFIG_MEMO;
  var map = cacheGet(CONFIG_CACHE_KEY);
  if (!map) {
    map = {};
    DEFAULT_CONFIG.forEach(function (r) { map[r[0]] = r[1]; });
    dbAll('CONFIG').forEach(function (r) { if (r.key) map[r.key] = r.value; });
    cachePut(CONFIG_CACHE_KEY, map, 600);
  }
  CONFIG_MEMO = map;
  return map;
}

/** Returns a single config value as string. */
function cfg(key) {
  var v = getConfigMap()[key];
  return v === undefined || v === null ? '' : String(v);
}

/** Returns config as integer. */
function cfgInt(key, def) {
  return toInt(cfg(key), def);
}

/** Returns config as boolean. */
function cfgBool(key) {
  return toBool(cfg(key));
}

/** Returns config as trimmed list. */
function cfgList(key) {
  return cfg(key).split(',').map(function (s) { return s.trim(); }).filter(String);
}

/** Clears config caches after an update. */
function invalidateConfig() {
  CONFIG_MEMO = null;
  cacheRemove(CONFIG_CACHE_KEY);
}

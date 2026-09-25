# Database Schema (Google Sheets)

- 1 Spreadsheet, 15 sheets, header row 1 (สร้าง/อัปเกรดด้วย `setupDatabase()` — ไม่ลบข้อมูลเดิม, เพิ่มคอลัมน์ที่ขาดต่อท้าย)
- ระบบอ่านคอลัมน์ตาม **ชื่อ header** จึงสลับลำดับคอลัมน์ได้ แต่ **ห้ามเปลี่ยนชื่อ header**
- คอลัมน์ข้อความใช้ format `@` (Plain text) เพื่อไม่ให้ Sheets แปลงวันที่/เวลา/รหัส
- วันเวลาเก็บเป็นข้อความเวลาไทย `yyyy-MM-dd HH:mm:ss` (Asia/Bangkok) เรียงลำดับได้
- ID ภายในเป็น UUID; เลข Order สำหรับคนอ่านเป็น `ORD-YYMMDD-XXXX`
- ไม่มีการลบแถวข้อมูลธุรกิจ (Soft delete / สถานะ) ยกเว้น session หมดอายุ, ล้างข้อมูลตัวอย่าง, Archive รายปี

## 01_CONFIG
| คอลัมน์ | คำอธิบาย |
|---|---|
| key | เช่น `COMPANY_NAME`, `MAX_QTY_PER_ORDER`, `ALLOW_EDIT`, `ALLOW_CANCEL`, `SUMMARY_INTERVAL_MINUTES`, `LINE_NOTIFICATION_MODE`, `LUNCH_OPEN_TIME` … (ดูทั้งหมดใน `DEFAULT_CONFIG` ใน Config.gs) |
| value | ค่า (ข้อความ) |
| description | คำอธิบาย |
| updated_at / updated_by | ผู้แก้ล่าสุด |

## 02_EMPLOYEES
`employee_id` (UUID) · `employee_code` (รหัสที่ใช้ login เช่น EMP00125, unique) · `name` · `department` · `role` (EMPLOYEE/KITCHEN/ADMIN/VIEWER) · `pin_hash` (`v1$salt$iterations$sha256`) · `status` (ACTIVE/DISABLED) · `must_change_pin` · `failed_attempts` · `locked_until` · `created_at` · `updated_at` · `last_login` · `is_sample`

## 03_USER_SESSIONS
`session_id` · `session_token` (SHA-256 ของ token+APP_SECRET — ไม่เก็บ token จริง) · `employee_id` · `role` · `created_at` · `expires_at` · `last_activity` · `revoked` · `remember` · `user_agent`

## 04_MEAL_WINDOWS
`window_id` · `date` · `meal` (BREAKFAST/LUNCH/DINNER) · `open_at` · `close_at` · `pickup_start` · `pickup_end` · `status` (DRAFT/OPEN/CLOSED/PREPARING/COMPLETED) · `auto` (TRUE = ตามเวลา) · `note` · `last_summary_at` · `final_sent_at` · `created_at` · `updated_at` · `created_by` · `is_sample`

## 05_MENU_ITEMS (Menu Master)
`item_id` · `code` (F001…) · `name` · `description` · `category` · `default_price` · `default_stock` · `max_per_order` (0=ไม่จำกัด) · `image_url` · `status` (ACTIVE/INACTIVE) · `is_deleted` (soft delete) · `sort_order` · `created_at` · `updated_at` · `is_sample`

## 06_DAILY_MENU (เมนูต่อมื้อ ราคา/จำนวนเฉพาะวัน)
`daily_menu_id` · `window_id` · `date` · `meal` · `item_id` · `item_name` · `price` · `stock_limit` · `sold_qty` (อัปเดตภายใต้ Lock เท่านั้น) · `max_per_order` · `status` (AVAILABLE/SOLD_OUT/DISABLED/REMOVED) · `sort_order` · `created_at` · `updated_at` · `is_sample`

## 07_ORDERS
`order_id` (UUID) · `order_no` (ORD-YYMMDD-XXXX) · `employee_id` · `employee_code` · `employee_name` · `department` (snapshot) · `window_id` · `order_date` · `meal` · `status` (CONFIRMED/PREPARING/READY/PICKED_UP/CANCELLED/NO_SHOW) · `total_qty` · `total_amount` · `items_json` (snapshot รายการ สำหรับแสดงผลเร็ว) · `note` · `request_token` (idempotency) · `created_at` · `updated_at` · `cancelled_at` · `cancelled_by` · `picked_up_at` · `picked_up_by` · `version` (optimistic concurrency) · `is_sample`

## 08_ORDER_ITEMS
`order_item_id` · `order_id` · `window_id` · `daily_menu_id` · `item_id` · `item_name_snapshot` · `qty` · `unit_price` · `subtotal` · `item_note` · `status` (ACTIVE / REMOVED เมื่อแก้ไข Order) · `created_at` · `is_sample`

ชื่อและราคาเป็น **snapshot** — เปลี่ยนเมนูภายหลังไม่กระทบ Order เก่า

## 09_ORDER_STATUS_LOG
`log_id` · `order_id` · `order_no` · `from_status` · `to_status` · `changed_by` · `changed_by_role` · `reason` · `created_at`

## 10_NOTIFICATION_QUEUE
`notification_id` · `type` (ORDER_INSTANT/ORDER_SUMMARY/FINAL_SUMMARY/SYSTEM_ALERT/TEST/PIN_RESET_REQUEST) · `recipient` · `payload` (JSON `{text}`) · `status` (PENDING/PROCESSING/SENT/FAILED/RETRY) · `retry_count` · `created_at` · `sent_at` · `last_error` · `next_retry_at` · `dedupe_key`

## 11_AUDIT_LOG
`audit_id` · `timestamp` · `user_id` · `user_code` · `role` · `action` (เช่น UPDATE_MENU) · `module` · `target_id` · `old_value` · `new_value` · `request_id`

## 12_PAYMENT
`payment_id` · `order_id` · `order_no` · `employee_id` · `employee_code` · `amount` · `method` (PAYROLL_DEDUCTION) · `status` (PENDING/VOID) · `period` (yyyy-MM สำหรับหักเงินเดือน) · `created_at` · `updated_at` · `is_sample`

## 13_DAILY_SUMMARY
`summary_id` · `date` · `meal` · `window_id` · `total_orders` · `total_qty` · `total_amount` · `cancelled` · `picked_up` · `no_show` · `created_at` · `updated_at` (อัปเดตตอนปิดรอบและจบมื้อ)

## 14_ERROR_LOG
`error_id` · `timestamp` · `request_id` · `module` · `function_name` · `user_id` · `error_code` · `error_message` · `stack`

## 15_SYSTEM_LOG
`log_id` · `timestamp` · `level` · `module` · `event` · `message` · `data`

---

## Status transitions (07_ORDERS)

```
CONFIRMED ─► PREPARING ─► READY ─► PICKED_UP
    │            │          │
    └──► CANCELLED ◄────────┘(ADMIN)     READY/CONFIRMED/PREPARING ─► NO_SHOW ─► PICKED_UP (รับช้า)
```
- EMPLOYEE: `CONFIRMED → CANCELLED` (ก่อนปิดรอบ, ALLOW_CANCEL) และแก้ไขรายการเฉพาะ CONFIRMED
- KITCHEN: ตามตารางด้านบน, ห้ามแก้ PICKED_UP / CANCELLED
- ADMIN: เพิ่มการย้อนสถานะ (เช่น PICKED_UP → READY กรณีกดผิด)
- ตาราง transition อยู่ที่ `ORDER_TRANSITIONS` ใน Config.gs

## Performance design
- อ่านชีตเป็น batch ครั้งเดียวต่อ execution (memo), เขียนเป็น batch (`setValues`)
- ค้นหาเฉพาะแถวที่เกี่ยวข้องด้วย TextFinder (เช่น Order ของมื้อ) แล้วอ่าน block เดียว — ไม่ต้องอ่านทั้งชีต
- Config และ Menu master อยู่ใน CacheService (10 นาที), session ใน cache
- รายงานสแกน ORDERS ย้อนหลังเป็นก้อน (2,500 แถว) และหยุดเมื่อเลยช่วงวันที่
- ปริมาณ 100 Orders/วัน ≈ 36,500 แถว/ปี — แนะนำ Archive รายปีด้วย `archiveOrdersByYear(year)`

## Archive
`archiveOrdersByYear(2025)` (รันจาก Editor): Backup ก่อน → คัดลอก Orders/Items/StatusLog/Payment ของปีนั้นไปไฟล์ `FoodFactory-Archive-2025` ในโฟลเดอร์ Backup → ลบออกจากชีตหลัก (ปีปัจจุบัน archive ไม่ได้)

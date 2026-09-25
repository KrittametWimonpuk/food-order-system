# Delivery Report — Factory Food Ordering System v1.0.0

วันที่ส่งมอบ: 25 กันยายน 2026

## 1. สิ่งที่สร้าง

ระบบจองอาหารโรงงานครบวงจรบน Google Apps Script + Google Sheets + LINE Messaging API
พร้อม Deploy เป็น Web App ใช้งานจริง (ซอร์สโค้ด ~8,200 บรรทัดใน `src/` + ชุดทดสอบ + เอกสาร)

## 2. Files

| กลุ่ม | ไฟล์ |
|---|---|
| Manifest | `src/appsscript.json` |
| Backend (21 ไฟล์ .gs, ~4,900 บรรทัด) | `Config, Main, Router, Auth, Session, Security, Validation, Database, Utils, EmployeeService, MealService, MenuService, OrderService, KitchenService, AdminService, ReportService, LineService, NotificationService, AuditService, BackupService, TriggerService` |
| Frontend (8 ไฟล์ .html, ~3,300 บรรทัด) | `index, styles, components, scripts, login, employee, kitchen, admin` |
| Tests | `tests/gas-mock.js` (Apps Script emulator), `tests/backend.test.js`, `tests/dev-server.js`, `tests/e2e.js` |
| Docs | `README.md, DEPLOYMENT.md, DATABASE_SCHEMA.md, LINE_SETUP.md, TEST_CHECKLIST.md, CHANGELOG.md, DELIVERY_REPORT.md`, `docs/screenshots/` |
| Tooling | `package.json` (test/dev/lint/push scripts), `.clasp.json.example`, `.gitignore` |

## 3. Features (หน้าจอครบ 21 หน้า)

01 Login · 02 Employee Home (Countdown จริง) · 03 Menu Detail · 04 Cart/Confirm · 05 Order Success (+QR) · 06 My Orders (วันนี้/ย้อนหลัง, แก้ไข/ยกเลิก) · 07 Kitchen Dashboard (KPI, Bar, Donut, สต็อก) · 08 Kitchen Order List (filter/search/pagination/bulk) · 09 Food Pickup (สแกน QR/รหัส, ป้องกันรับซ้ำ) · 10 Admin Dashboard (+ health check) · 11 Menu Management · 12 Daily Menu · 13 Meal Windows · 14 Employee Management (+ CSV import) · 15 Order Management · 16 Reports (+ Export CSV) · 17 LINE Settings (+ Queue/Retry) · 18 System Settings (+ Triggers) · 19 Audit Log · 20 Error/System Log · 21 Backup
เพิ่มเติม: สรุปยอดประจำวัน (พิมพ์/ส่ง LINE), หน้าตั้งค่าของครัว, บังคับเปลี่ยน PIN, ลืม PIN, หน้า "อื่นๆ" ของพนักงาน

ปุ่มที่แสดงทุกปุ่มทำงานจริง (ปุ่มสแกนด้วยกล้องแสดงเฉพาะเมื่อ browser รองรับ)

## 4. Database Sheets

15 ชีต: `01_CONFIG, 02_EMPLOYEES, 03_USER_SESSIONS, 04_MEAL_WINDOWS, 05_MENU_ITEMS, 06_DAILY_MENU, 07_ORDERS, 08_ORDER_ITEMS, 09_ORDER_STATUS_LOG, 10_NOTIFICATION_QUEUE, 11_AUDIT_LOG, 12_PAYMENT, 13_DAILY_SUMMARY, 14_ERROR_LOG, 15_SYSTEM_LOG` — สร้างอัตโนมัติด้วย `setupDatabase()` (idempotent, ไม่ลบข้อมูล)
คอลัมน์เพิ่มเติมจาก spec (เพื่อประสิทธิภาพ/ความปลอดภัย): `items_json`, `version`, snapshot พนักงานใน ORDERS; `window_id`, `status` ใน ORDER_ITEMS; `failed_attempts`, `locked_until` ใน EMPLOYEES; `dedupe_key`, `next_retry_at` ใน QUEUE; `is_sample` สำหรับล้างข้อมูลตัวอย่าง

## 5. Security

- PIN: ไม่เก็บ plain text — `v1$salt$500$sha256` (per-user salt + pepper `PIN_SALT` ใน Script Properties)
- Session token สุ่ม 256-bit เก็บเฉพาะ hash (+`APP_SECRET`), sliding expiry, remember-me, revoke เมื่อ logout/disable/reset PIN/เปลี่ยน role
- Rate limit + lockout, บังคับเปลี่ยน PIN, ข้อความ error ไม่บอกว่ารหัสมีอยู่จริงหรือไม่ (ลืม PIN)
- RBAC ทุก route ที่ server (role อ่านจาก employee record ปัจจุบัน) — client ส่ง employee_id/role/price/status มาไม่มีผล
- Validate: payload, ID, qty, price, status transition, cutoff, เวลา, URL รูป (https เท่านั้น), ขนาดไฟล์
- Sanitize input + escape output ทุกจุดใน UI (`esc()`), ป้องกัน formula injection ในชีตและ CSV, ไม่มี `eval()`
- Secrets ทั้งหมดอยู่ใน Script Properties, หน้า LINE แสดง token แบบ mask
- LockService ใน critical sections, idempotency key, optimistic `version`
- Audit log ทุก action สำคัญ (old → new), Error log พร้อม requestId

## 6. Tests

| ชุด | ผล |
|---|---|
| Backend (`npm test`) — 14 suites ครอบคลุม login, lockout, session, ordering rules, double submit, stock race, edit/cancel, kitchen transitions, pickup, RBAC, admin CRUD, settings, scheduler, LINE summary/final/retry/failure, backup, reports/CSV, sample cleanup, error log, sanitisation | ✅ 14/14 |
| E2E UI (`npm run test:e2e`) — Playwright: employee mobile flow, kitchen flow, admin ทุกหน้า, viewer, responsive 320–1920, console errors | ✅ 42/42 (รันซ้ำ 3 รอบ) |
| Syntax check ทุกไฟล์ .gs (`npm run lint`) | ✅ |

รายละเอียด: [TEST_CHECKLIST.md](TEST_CHECKLIST.md)

## 7. สิ่งที่ผ่าน (Acceptance Criteria)

- [x] Login ใช้งานจริง
- [x] Employee สามารถ Order จริง
- [x] Order ลง Google Sheets จริง (ORDERS, ORDER_ITEMS, STATUS_LOG, PAYMENT)
- [x] ป้องกัน Duplicate (request_token + UI guard)
- [x] Stock ถูกต้อง (LockService; ทดสอบแข่งกันซื้อชิ้นสุดท้าย)
- [x] Cancel ทำงาน (คืนสต็อก)
- [x] Kitchen Dashboard อ่าน Database จริง
- [x] Kitchen เปลี่ยน Status ได้
- [x] Pickup ทำงาน (กันรับซ้ำ)
- [x] Admin Menu ทำงาน
- [x] Employee Management ทำงาน
- [x] Report ใช้งานได้ (+ Export CSV)
- [x] LINE Messaging API พร้อมเชื่อมต่อ (ต้องใส่ token จริง)
- [x] Queue ทำงาน (retry/failed/manual retry)
- [x] Trigger พร้อมใช้งาน (`setupTriggers()`)
- [x] Backup ทำงาน
- [x] Role Permission ทำงาน
- [x] Audit Log ทำงาน
- [x] Error Log ทำงาน
- [x] Responsive Mobile (320–768)
- [x] Responsive Desktop (768–1920)
- [x] ไม่มี Critical Error ใน Console (ตรวจอัตโนมัติใน E2E)
- [x] ไม่มี Placeholder Button

## 8. สิ่งที่ต้องตั้งค่าภายนอก

1. สร้าง Google Sheet + วางโค้ดใน Apps Script (DEPLOYMENT.md ขั้น 1–3)
2. Script Properties: `INIT_ADMIN_ID`, `INIT_ADMIN_NAME`, `INIT_ADMIN_PIN`, `BASE_URL`
3. LINE: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_TARGET_ID` (+ `LINE_CHANNEL_SECRET`) — LINE_SETUP.md
4. Run `setupDatabase()` → `setupFirstAdmin()` → `setupTriggers()` แล้ว Deploy Web App (Execute as Me, Anyone)
5. เพิ่มเมนูและพนักงานจริง (หรือ Import CSV) · ล้างข้อมูลตัวอย่างถ้าเคย seed

## 9. Deployment Status

- ✅ Source code พร้อม Deploy (ตรวจ syntax, ตรวจ load order ของไฟล์, ตรวจ HTML include, ตรวจ client/server calls ผ่าน E2E)
- ⏳ ยังไม่ได้ Deploy บนบัญชี Google ของโรงงาน (ต้องใช้บัญชีและสิทธิ์ของลูกค้า) — ทำตาม DEPLOYMENT.md ~20–30 นาที
- ⏳ LINE จริงต้องใช้ token ของ LINE OA ของโรงงาน (ทดสอบด้วย mock HTTP แล้ว)

## 10. Known Limitations

- Google Sheets ไม่ใช่ RDBMS: การเขียนถูก serialize ด้วย LockService (ออกแบบรองรับ ~100 Orders ในช่วงพีคได้สบาย แต่แต่ละคำขอใช้เวลา ~1–3 วินาทีตามความเร็ว Apps Script)
- Apps Script quotas: UrlFetch/Trigger runtime ตามประเภทบัญชี (Gmail ฟรี vs Workspace) — โหมด SUMMARY ใช้โควตาน้อยมาก
- Apps Script ไม่ให้อ่าน HTTP header → ตรวจ `X-Line-Signature` ของ webhook ไม่ได้ (webhook ใช้เฉพาะเก็บ Group ID)
- Scheduler ทำงานทุก 5 นาที: การเปลี่ยนสถานะที่แสดงผลอาจช้าได้ถึง 5 นาที แต่การปิดรับ Order บังคับตามเวลาจริงที่ server เสมอ และ UI คำนวณสถานะตามเวลาปัจจุบัน
- Web App ถูกโหลดใน iframe ของ Google: การดาวน์โหลดไฟล์บาง browser อาจถูกบล็อก (มีปุ่ม "บันทึกไป Google Drive" สำรอง), การเปิดกล้องอาจไม่ได้รับอนุญาต (รองรับเครื่องสแกน USB/Bluetooth และการพิมพ์รหัส)
- QR Code ใช้ library จาก cdnjs; ถ้าโหลดไม่ได้จะแสดงเลข Order แทน (ค้นหาด้วยเลข Order/รหัสพนักงานได้เหมือนเดิม)
- Export เป็น CSV (UTF-8 BOM เปิดใน Excel ได้) ไม่ใช่ .xlsx
- ระบบชำระเงินเก็บเป็นรายการหักเงินเดือน (`12_PAYMENT`) ยังไม่มีหน้าสรุปเงินเดือน
- Archive รายปีเป็นฟังก์ชันรันด้วยมือ (`archiveOrdersByYear`)

## 11. Recommended Next Version

1. หน้าสรุปหักเงินเดือนรายเดือน (Payroll export) จาก `12_PAYMENT`
2. LIFF (LINE Front-end Framework) ให้พนักงานสั่งผ่าน LINE และรับแจ้งเตือนส่วนตัว (เช่น "อาหารพร้อมรับ")
3. สั่งล่วงหน้าหลายวัน / เมนูประจำสัปดาห์ / Template เมนู
4. Export .xlsx ผ่าน Google Sheets API + รายงาน PDF
5. ย้ายฐานข้อมูลไป Cloud SQL / Firestore เมื่อเกิน ~500 Orders/วัน
6. Automate archive รายปี + dashboard เปรียบเทียบปีต่อปี
7. PWA (manifest/service worker) บน hosting แยกเพื่อใช้กล้องสแกน QR ได้เต็มรูปแบบ
8. แจ้งเตือนพนักงานที่ยังไม่สั่งก่อนปิดรอบ (reminder)

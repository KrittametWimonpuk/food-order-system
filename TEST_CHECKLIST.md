# Test Checklist

- **Auto (BE)** = ทดสอบอัตโนมัติใน `tests/backend.test.js` (รันโค้ด server จริงบน Apps Script emulator)
- **Auto (UI)** = ทดสอบอัตโนมัติใน `tests/e2e.js` (Playwright + Chromium, UI จริง + backend จำลอง)
- **Manual** = ต้องทดสอบบน Google Apps Script จริงหลัง Deploy

ผลการรันล่าสุด: Backend 14/14 suites ผ่าน · E2E 42/42 checks ผ่าน (รันซ้ำ 3 รอบ ผ่านทุกรอบ)

| # | Test case | วิธีทดสอบ | ผล |
|---|---|---|---|
| 1 | Login สำเร็จ | Auto (BE, UI) | ✅ |
| 2 | Login ผิด (แจ้งจำนวนครั้งที่เหลือ) | Auto (BE, UI) | ✅ |
| 3 | Employee Disabled เข้าสู่ระบบไม่ได้ + session ถูก revoke | Auto (BE) | ✅ |
| 4 | Lockout หลังผิด 5 ครั้ง / ปลดล็อกหลัง 15 นาที | Auto (BE) | ✅ |
| 5 | Rate limit (10 ครั้ง / 10 นาที / รหัส) | Auto (BE) | ✅ |
| 6 | Session Expire (idle 120 นาที) / Logout revoke / token ปลอม | Auto (BE) | ✅ |
| 7 | Admin คนแรกถูกบังคับเปลี่ยน PIN | Auto (BE, UI) | ✅ |
| 8 | Order ก่อนเปิดเวลา → MEAL_NOT_OPEN | Auto (BE) | ✅ |
| 9 | Order หลังปิดเวลา → MEAL_CLOSED (แก้ไข/ยกเลิกก็ไม่ได้) | Auto (BE) | ✅ |
| 10 | Order ปกติ + เลข ORD-260925-0001 | Auto (BE, UI) | ✅ |
| 11 | Order หลายรายการ + หมายเหตุ | Auto (BE, UI) | ✅ |
| 12 | Double Click / ส่งซ้ำ request_token เดิม → Order เดิม (ไม่สร้างใหม่) | Auto (BE, UI dblclick) | ✅ |
| 13 | มี Order ในมื้อแล้ว → ORDER_EXISTS | Auto (BE) | ✅ |
| 14 | ราคาเปลี่ยนระหว่างสั่ง → PRICE_CHANGED | Auto (BE) | ✅ |
| 15 | Max qty ต่อ Order (server + UI) / qty 0 | Auto (BE, UI) | ✅ |
| 16 | Client ส่ง employee_id / ราคาปลอม → server ไม่เชื่อ | Auto (BE) | ✅ |
| 17 | Stock เต็ม → MENU_SOLD_OUT | Auto (BE) | ✅ |
| 18 | 2 คนสั่งชิ้นสุดท้ายพร้อมกัน → ขายได้ 1 (Lock) / Lock timeout ตอบข้อความที่เหมาะสม | Auto (BE) | ✅ |
| 19 | Edit Order → สต็อกปรับตาม | Auto (BE, UI) | ✅ |
| 20 | Cancel Order → คืนสต็อก + Payment VOID + สั่งใหม่ได้ | Auto (BE) | ✅ |
| 21 | ยกเลิก Order ของคนอื่น → ACCESS_DENIED | Auto (BE) | ✅ |
| 22 | Kitchen เปลี่ยนสถานะ / transition ไม่ถูกต้องถูกปฏิเสธ | Auto (BE, UI) | ✅ |
| 23 | Pickup + บันทึก picked_up_at / picked_up_by | Auto (BE, UI) | ✅ |
| 24 | Pickup ซ้ำ → ORDER_ALREADY_PICKED_UP | Auto (BE, UI) | ✅ |
| 25 | Admin ย้อนสถานะ PICKED_UP → READY | Auto (BE) | ✅ |
| 26 | Admin Add/Edit/Toggle/Soft-delete Menu, validate URL/ราคา | Auto (BE, UI) | ✅ |
| 27 | Admin Add Employee (PIN สุ่ม), รหัสซ้ำ, Reset PIN (revoke session), Import CSV | Auto (BE, UI) | ✅ |
| 28 | ห้ามปิดบัญชีตัวเอง / ห้ามลด ADMIN คนสุดท้าย | Auto (BE) | ✅ |
| 29 | Settings save + validate (เวลาไม่ถูกต้อง, key ต้องห้าม) | Auto (BE, UI) | ✅ |
| 30 | Scheduler: สร้างมื้อ → OPEN → CLOSED → COMPLETED ตามเวลา | Auto (BE) | ✅ |
| 31 | LINE Summary ทุก 30 นาที (ข้อความ + Authorization header) | Auto (BE, mocked HTTP) | ✅ |
| 32 | Final Summary ตอนปิดรอบ (ส่งครั้งเดียว) | Auto (BE) | ✅ |
| 33 | LINE Failure → Order ยังสำเร็จ (INSTANT mode) | Auto (BE) | ✅ |
| 34 | Notification Retry 3 ครั้ง → FAILED → Admin Retry manual → SENT | Auto (BE) | ✅ |
| 35 | ทดสอบส่ง LINE / Token ไม่ถูกส่งกลับไปหน้าเว็บ | Auto (BE) | ✅ |
| 36 | NO_SHOW อัตโนมัติ + Daily Summary | Auto (BE) | ✅ |
| 37 | Backup → FoodFactory-Backup/2026/09/, ไม่เขียนทับ | Auto (BE, mocked Drive) | ✅ |
| 38 | Export Report CSV (BOM UTF-8, 5 ประเภท) + ป้องกัน formula injection | Auto (BE) | ✅ |
| 39 | Role Permission (Employee/Kitchen/Viewer/Admin) + UNKNOWN_ACTION | Auto (BE, UI) | ✅ |
| 40 | Unexpected error → ERROR_LOG + ข้อความทั่วไปถึงผู้ใช้ | Auto (BE) | ✅ |
| 41 | Sanitize input / payload ไม่ถูกต้อง / request_token ไม่ถูกต้อง | Auto (BE) | ✅ |
| 42 | setupDatabase idempotent + เพิ่มคอลัมน์ใหม่โดยไม่ลบข้อมูล | Auto (BE) | ✅ |
| 43 | ล้างข้อมูลตัวอย่างไม่กระทบ Config และ Order จริง | Auto (BE) | ✅ |
| 44 | Countdown นับถอยหลังจริง | Auto (UI) | ✅ |
| 45 | Mobile Responsive 320 / 390 / 768 (ไม่มี horizontal scroll) | Auto (UI) | ✅ |
| 46 | Desktop Responsive 768 / 1024 / 1366 / 1440 / 1920 | Auto (UI) | ✅ |
| 47 | Sidebar collapse / mobile drawer | Auto (UI) | ✅ |
| 48 | ทุกหน้า Admin เปิดได้ ไม่มี JS error ใน console | Auto (UI) | ✅ |
| 49 | Logout → กลับหน้า Login | Auto (UI) | ✅ |
| 50 | Deploy จริงบน Apps Script + สิทธิ์ OAuth | Manual | ⏳ ทำตาม DEPLOYMENT.md |
| 51 | ส่ง LINE จริงเข้ากลุ่ม | Manual | ⏳ ต้องมี Token จริง |
| 52 | Backup จริงไป Google Drive / Upload รูปเมนู | Manual | ⏳ |
| 53 | ดาวน์โหลด CSV ใน iframe ของ Apps Script (fallback: บันทึกไป Drive) | Manual | ⏳ |
| 54 | สแกน QR ด้วยเครื่องสแกน USB / กล้อง (BarcodeDetector) | Manual | ⏳ ขึ้นกับอุปกรณ์ |
| 55 | ทดสอบโหลดจริง 20–50 คนสั่งพร้อมกันช่วงพีค | Manual | ⏳ แนะนำก่อน Go-live |

## วิธีรันทดสอบอัตโนมัติ
```bash
npm test                      # backend
npm i -D playwright           # ครั้งแรก (หรือใช้ playwright ที่ติดตั้งแบบ global)
npx playwright install chromium
npm run test:e2e              # UI — ภาพหน้าจอจะอยู่ใน tests/output/
```

## Manual test script (หลัง Deploy)
1. Login Admin → เปลี่ยน PIN → Settings ตั้งเวลาเปิด/ปิดให้ครอบคลุมเวลาปัจจุบัน
2. เพิ่มเมนู 2 รายการ (หนึ่งรายการ Stock = 1) → Daily Menu ตรวจว่ามีในมื้อวันนี้
3. มือถือ 2 เครื่อง Login คนละคน กดสั่งเมนู Stock=1 พร้อมกัน → ต้องสำเร็จ 1 คน อีกคนได้ "เมนูนี้หมดแล้ว"
4. ปิด Wi-Fi ระหว่างกดยืนยัน → เปิดใหม่ → กดยืนยันอีกครั้ง → ต้องได้ Order เดียว
5. ครัว: เริ่มเตรียม → พร้อมรับ → รับอาหาร → สแกนซ้ำต้องขึ้น "รับอาหารไปแล้ว"
6. LINE: ทดสอบส่ง → ตั้งเวลาปิดรับเป็นอีก 5 นาที → รอ Final summary
7. Backup ตอนนี้ → เปิดโฟลเดอร์ใน Drive
8. Reports → Export CSV → เปิดใน Excel ภาษาไทยต้องไม่เพี้ยน

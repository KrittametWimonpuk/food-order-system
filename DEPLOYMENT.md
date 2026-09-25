# Deployment Guide — Factory Food Ordering System

เวลาที่ใช้ประมาณ 20–30 นาที ไม่ต้องมีความรู้ด้านโปรแกรม

---

## 1. สร้าง Google Sheet

1. ไปที่ <https://sheets.new> (ใช้บัญชี Google ของโรงงาน/ผู้ดูแลระบบ — บัญชีนี้จะเป็นเจ้าของข้อมูลและผู้รัน Web App)
2. ตั้งชื่อไฟล์ เช่น `FoodFactory-DB`

> ไม่ต้องสร้างชีต/หัวคอลัมน์เอง ระบบสร้างให้ในขั้นตอนที่ 5

## 2. เปิด Apps Script

ในไฟล์ Google Sheet → เมนู **Extensions (ส่วนขยาย) → Apps Script**
(สคริปต์จะผูกกับชีตนี้ ระบบจะใช้ชีตนี้เป็นฐานข้อมูลอัตโนมัติ)

## 3. เพิ่ม Source Code

### วิธี A — คัดลอกผ่าน Editor
1. Project Settings (⚙️) → ติ๊ก **Show "appsscript.json" manifest file in editor**
2. เปิด `appsscript.json` แล้ววางเนื้อหาจาก `src/appsscript.json`
3. สร้างไฟล์ **Script** (`+` → Script) ตามชื่อ แล้ววางเนื้อหาให้ครบทุกไฟล์ (ไม่ต้องพิมพ์ `.gs`):
   `Config, Utils, Database, Security, Session, Auth, AuditService, Validation, EmployeeService, MealService, MenuService, OrderService, KitchenService, ReportService, LineService, NotificationService, BackupService, TriggerService, AdminService, Router, Main`
4. สร้างไฟล์ **HTML** (`+` → HTML) ตามชื่อ: `index, styles, components, scripts, login, employee, kitchen, admin`
5. ลบไฟล์ `Code.gs` เดิม (ถ้าว่าง) แล้วกด 💾 Save

### วิธี B — clasp (สำหรับนักพัฒนา)
```bash
npm i -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # ใส่ scriptId ของโปรเจกต์ (Project Settings → IDs)
clasp push
```

## 4. ตั้ง Script Properties

Project Settings → **Script Properties → Add script property**

| Property | ตัวอย่างค่า | หมายเหตุ |
|---|---|---|
| `INIT_ADMIN_ID` | `ADMIN01` | รหัส Admin คนแรก |
| `INIT_ADMIN_NAME` | `ผู้ดูแลระบบ` | |
| `INIT_ADMIN_PIN` | `482913` (ตัวอย่าง — ตั้งเอง) | ตัวเลข 4–8 หลัก ห้ามเรียงหรือซ้ำ · ถูกลบอัตโนมัติหลังสร้าง Admin |
| `BASE_URL` | (ใส่หลังขั้นตอน 11) | URL ของ Web App |
| `LINE_CHANNEL_ACCESS_TOKEN` | (ขั้นตอน 9) | |
| `LINE_TARGET_ID` | (ขั้นตอน 9) | |

ค่าต่อไปนี้ **ระบบสร้างเองอัตโนมัติ** ไม่ต้องตั้ง: `DATABASE_SHEET_ID`, `APP_SECRET`, `PIN_SALT`, `BACKUP_FOLDER_ID`, `IMAGE_FOLDER_ID`, `EXPORT_FOLDER_ID`
⚠️ ห้ามลบหรือแก้ `PIN_SALT` หลังใช้งานจริง (PIN ทุกคนจะใช้ไม่ได้)

> ถ้าใช้ **standalone script** (ไม่ได้สร้างจากเมนู Extensions) ให้ตั้ง `DATABASE_SHEET_ID` = ID ใน URL ของ Google Sheet เอง

## 5. Run `setupDatabase()`

ใน Editor เลือกไฟล์ `Main.gs` → dropdown ฟังก์ชันเลือก `setupDatabase` → **Run**
- ครั้งแรกจะขอสิทธิ์: Review permissions → เลือกบัญชี → Advanced → Go to project (unsafe) → Allow
- ตรวจ Google Sheet: ต้องมีชีต `01_CONFIG` … `15_SYSTEM_LOG`
- รันซ้ำได้อย่างปลอดภัย (ไม่ลบข้อมูล เพิ่มเฉพาะที่ขาด)

## 6. สร้าง Admin

Run `setupFirstAdmin()` → ดู **Execution log** ต้องเห็น `✅ First admin created: ADMIN01`
(ถ้าไม่ได้ตั้ง `INIT_ADMIN_PIN` ระบบจะสุ่ม PIN และแสดงใน log)

ต้องการข้อมูลทดลอง: Run `seedSampleData()` → log จะแสดงรหัสพนักงานตัวอย่าง + PIN
(พนักงาน 4 คน, ครัว `KIT001`, ผู้บริหาร `VIEW001`, เมนู 4 รายการ) — ลบภายหลังได้ที่ Settings → "ล้างข้อมูลตัวอย่าง"

## 7. ตั้ง LINE Official Account

ดูรายละเอียดใน [LINE_SETUP.md](LINE_SETUP.md)
1. <https://manager.line.biz> → สร้าง LINE Official Account (ฟรี)
2. Settings → Messaging API → **Enable Messaging API** → เลือก/สร้าง Provider

## 8. ตั้ง Messaging API

1. <https://developers.line.biz/console/> → เลือก Channel ของ OA
2. แท็บ **Messaging API** → **Channel access token (long-lived)** → Issue → คัดลอก
3. แท็บ Basic settings → คัดลอก **Channel secret** (ไม่บังคับ)
4. ปิด Auto-reply / Greeting ใน LINE OA Manager (ไม่บังคับ แต่แนะนำ)

## 9. เพิ่ม Token

Script Properties:
- `LINE_CHANNEL_ACCESS_TOKEN` = token จากข้อ 8
- `LINE_CHANNEL_SECRET` = secret (ไม่บังคับ)
- `LINE_TARGET_ID` = Group ID ของกลุ่มครัว (`C…`) หรือ User ID (`U…`) — วิธีหา ID ดู LINE_SETUP.md

## 10. `setupTriggers()`

Run `setupTriggers()` → อนุญาตสิทธิ์เพิ่ม → ตรวจที่เมนู ⏰ Triggers ต้องมี `runScheduler`, `dailyBackupJob`, `dailyMaintenance`
(ภายหลังทำจากหน้าเว็บได้: Admin → ตั้งค่าระบบ → "ติดตั้ง/อัปเดต Trigger")

## 11. Deploy Web App

1. **Deploy → New deployment** → ⚙️ Select type → **Web app**
2. Description: `v1.0.0`
3. **Execute as: Me** (บัญชีเจ้าของ — จำเป็น เพราะพนักงานไม่ได้มีสิทธิ์เข้าถึงชีตโดยตรง)
4. **Who has access: Anyone** (พนักงานไม่ต้องมีบัญชี Google — ความปลอดภัยใช้ รหัสพนักงาน + PIN)
   - ถ้าทุกคนมีบัญชี Google Workspace ขององค์กร เลือก "Anyone within <domain>" ได้
5. Deploy → คัดลอก **Web app URL** (`https://script.google.com/macros/s/…/exec`)
6. ใส่ URL ใน Script Property `BASE_URL`

> ทุกครั้งที่แก้โค้ด: Deploy → **Manage deployments** → ✏️ Edit → Version: **New version** → Deploy (URL เดิม)

## 12. Permission

สิทธิ์ที่ระบบขอ (ดู `appsscript.json`):
- `spreadsheets` — อ่าน/เขียนฐานข้อมูล
- `drive` — Backup, รูปเมนู, ไฟล์ Export
- `script.external_request` — เรียก LINE Messaging API
- `script.scriptapp` — ติดตั้ง Trigger

ไม่ต้องแชร์ Google Sheet ให้พนักงาน (แนะนำให้แชร์เฉพาะผู้ดูแลระบบ)

## 13. เปิด URL

- พนักงาน: ส่งลิงก์ Web App (แนะนำทำ QR Code ติดโรงอาหาร / "Add to Home Screen")
- ครัว: `<URL>?page=kitchen` · จุดรับอาหาร: `<URL>?page=pickup` · Admin: `<URL>?page=admin`

## 14. Login

1. เข้าด้วย `ADMIN01` + PIN จากขั้นตอน 4 → ระบบบังคับตั้ง PIN ใหม่
2. ตั้งค่าระบบ → ชื่อบริษัท, แผนก, เวลาเปิด/ปิดรับจอง, Max Qty ฯลฯ → บันทึก
3. จัดการเมนู → เพิ่มเมนู (ราคา, จำนวนสูงสุด, รูป)
4. จัดการพนักงาน → เพิ่มทีละคน หรือ Import CSV → แจก PIN เริ่มต้น

## 15. Test Order

1. จัดการมื้ออาหาร → ตรวจว่ามีมื้อวันนี้ (สร้างอัตโนมัติ) หรือกด "สร้างมื้ออาหาร"
2. ถ้ายังไม่ถึงเวลาเปิด: กด "สถานะ" → "เปิดรับจอง" (โหมดกำหนดเอง)
3. เปิด URL บนมือถือ → Login พนักงาน → สั่งอาหาร → ยืนยัน → เห็นหน้า "สั่งอาหารเรียบร้อย"
4. Google Sheet `07_ORDERS` ต้องมีแถวใหม่ · หน้า Kitchen Dashboard ต้องเห็นยอด
5. ครัว → รับอาหาร → ค้นหารหัสพนักงาน → "✓ รับอาหารแล้ว"

## 16. Test LINE

Admin → **LINE** → สถานะต้องเป็น `Connected` → กด **ทดสอบส่ง LINE** → กลุ่มต้องได้ข้อความ
`✅ Factory Food Ordering System / LINE Messaging API เชื่อมต่อสำเร็จ / เวลา: …`
ถ้าไม่สำเร็จ ดูคอลัมน์ข้อผิดพลาดใน Notification Queue และ LINE_SETUP.md

---

## Checklist ก่อนใช้งานจริง

- [ ] เปลี่ยน PIN Admin แล้ว และมี Admin สำรองอย่างน้อย 1 คน
- [ ] ล้างข้อมูลตัวอย่าง (ถ้าเคย seed)
- [ ] ตั้งเวลา/วันทำงาน/แผนก ถูกต้อง
- [ ] Trigger ครบ 3 ตัว, Backup ทดลองกด "Backup ตอนนี้" สำเร็จ
- [ ] LINE ทดสอบส่งสำเร็จ
- [ ] ทดลองสั่ง–รับอาหารจริง 1 รอบ

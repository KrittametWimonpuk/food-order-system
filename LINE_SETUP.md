# LINE Messaging API Setup

ระบบใช้ **LINE Official Account + Messaging API (push message)**
(LINE Notify ปิดให้บริการแล้ว — ระบบนี้ไม่ใช้)

## 1. สร้าง LINE Official Account
1. เข้า <https://manager.line.biz> ด้วยบัญชี LINE → **Create** → กรอกชื่อ เช่น `ครัวโรงงาน ABC`
2. เข้า OA → **Settings → Messaging API → Enable Messaging API** → เลือก/สร้าง Provider
3. **Settings → Account settings**: เปิด "Allow bot to join group chats"
4. **Response settings**: ปิด Auto-response (แนะนำ) และ Greeting message

## 2. Channel Access Token
1. <https://developers.line.biz/console/> → Provider → Channel ของ OA
2. แท็บ **Messaging API** → หัวข้อ *Channel access token (long-lived)* → **Issue** → คัดลอก
3. Apps Script → Project Settings → Script Properties → `LINE_CHANNEL_ACCESS_TOKEN`
4. (ไม่บังคับ) แท็บ Basic settings → Channel secret → `LINE_CHANNEL_SECRET`

> Token เก็บใน Script Properties เท่านั้น — ไม่อยู่ใน source code และหน้าเว็บแสดงแบบ mask (`abcd••••••wxyz`)

## 3. หา Target ID (Group ID)

ข้อความถูกส่งแบบ push ไปที่ `LINE_TARGET_ID` ซึ่งเป็น
- **Group ID** (ขึ้นต้น `C`) — แนะนำ: สร้างกลุ่ม LINE "ครัว" แล้วเชิญบอทเข้ากลุ่ม
- **User ID** (ขึ้นต้น `U`) — ส่งหาบุคคล (ดูของตัวเองได้ที่ Basic settings → Your user ID)

### วิธีหา Group ID ด้วยระบบนี้
1. Admin → ตั้งค่าระบบ → เปิด **"บันทึก Group ID จาก Webhook"** (`LINE_WEBHOOK_CAPTURE = TRUE`) → บันทึก
2. LINE Developers → Messaging API → **Webhook URL** = Web App URL (`https://script.google.com/macros/s/…/exec`) → Update → เปิด **Use webhook**
   (ปุ่ม Verify อาจแสดง error เพราะ Apps Script redirect — ไม่เป็นไร)
3. เชิญบอทเข้ากลุ่ม แล้วพิมพ์ข้อความใดก็ได้ในกลุ่ม
4. Admin → System Log → แท็บ System Log → หา event `WEBHOOK_MESSAGE` / `WEBHOOK_JOIN` → คัดลอก `groupId`
5. ใส่ใน Script Property `LINE_TARGET_ID` แล้ว **ปิด** LINE_WEBHOOK_CAPTURE (และปิด Use webhook ได้)

> ข้อจำกัด: Apps Script อ่าน HTTP header ไม่ได้ จึงตรวจ `X-Line-Signature` ไม่ได้ — ระบบจึงใช้ webhook แค่บันทึก ID ลง log (ไม่มี action อื่น) และเปิดเฉพาะช่วงตั้งค่า

## 4. ทดสอบ
Admin → **LINE** → Connected → **ทดสอบส่ง LINE** → กลุ่มได้ข้อความ:
```
✅ Factory Food Ordering System

LINE Messaging API เชื่อมต่อสำเร็จ

เวลา: 25 กันยายน 2026 09:30 น.
```

## 5. Notification Modes (`LINE_NOTIFICATION_MODE`)

| Mode | พฤติกรรม |
|---|---|
| `SUMMARY` (default) | สรุปยอดทุก `SUMMARY_INTERVAL_MINUTES` (30) นาทีระหว่างเปิดรับ (เฉพาะเมื่อมี Order) + Final summary ตอนปิดรอบ |
| `INSTANT` | ส่งทุกครั้งที่มี Order ใหม่ / แก้ไข / ยกเลิก + Final summary |
| `CUTOFF` | ส่งเฉพาะ Final summary ตอนปิดรอบ |

ตัวอย่าง Summary
```
🍱 สรุปยอดอาหาร
มื้อกลางวัน 25/09/2026
เวลา 09:30 น.

กะเพราไก่ + ไข่ดาว 20
ข้าวมันไก่ 14
ข้าวผัดหมู 10
ราดหน้า 8

รวม 52 กล่อง (48 Order)
ปิดรับ 10:30 น.
```
ตัวอย่าง Final summary
```
🔴 ปิดรับ Order แล้ว
มื้อกลางวัน 25/09/2026

กะเพราไก่ + ไข่ดาว 32
ข้าวมันไก่ 21
ข้าวผัดหมู 18
ราดหน้า 16

รวม 87 Order
93 กล่อง
รับอาหาร 11:30-13:00 น.

Kitchen Dashboard:
https://script.google.com/macros/s/…/exec?page=kitchen
```
นอกจากนี้: คำขอ "ลืม PIN" และ Backup ล้มเหลว จะแจ้งเข้า LINE เดียวกัน

## 6. Queue & Retry
- Order บันทึกสำเร็จก่อนเสมอ แล้วจึงเพิ่มข้อความเข้า `10_NOTIFICATION_QUEUE` (LINE ล่ม ≠ Order ล้ม)
- Scheduler ส่งคิวทุก 5 นาที · สถานะ `PENDING → PROCESSING → SENT`
- ล้มเหลว → `RETRY` (backoff 2, 4 นาที) → ครบ 3 ครั้ง → `FAILED`
- Admin → LINE → Notification Queue → ปุ่ม **Retry** เพื่อส่งใหม่ด้วยมือ
- ใช้ `X-Line-Retry-Key` ป้องกันข้อความซ้ำเมื่อ retry
- ข้อความค้างเกิน 24 ชม. (เช่น ยังไม่ตั้ง token) → `FAILED (expired)` เพื่อไม่ส่งสรุปเก่าย้อนหลัง

## 7. Troubleshooting
| last_error | สาเหตุ |
|---|---|
| `HTTP 401` | Token ผิด/หมดอายุ → Issue ใหม่ |
| `HTTP 400 … to` | `LINE_TARGET_ID` ผิด หรือบอทไม่ได้อยู่ในกลุ่ม |
| `HTTP 429` | เกินโควตาข้อความของแพ็กเกจ OA (ฟรี 200–300 ข้อความ/เดือน) → ใช้โหมด SUMMARY/CUTOFF หรืออัปเกรดแพ็กเกจ |
| `LINE_NOT_CONFIGURED` | ยังไม่ได้ตั้ง Token/Target ID |

> ประมาณการโควตา: โหมด SUMMARY ~ 5–6 ข้อความ/วัน ≈ 150 ข้อความ/เดือน (พอสำหรับแพ็กเกจฟรี) · โหมด INSTANT 100 Orders/วัน จะเกินแพ็กเกจฟรี

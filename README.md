# Dialysis Smart Claim System

ทะเบียนผู้รับบริการฟอกไต (Hemodialysis Patient Registry) สำหรับโรงพยาบาลที่ใช้ HOSxP — เชื่อมต่อข้อมูลผ่าน BMS HOSxP API

## ✨ ฟีเจอร์

- **หน้าจอ Login** ด้วย BMS Session ID — ตรวจสอบกับ HOSxP API ทุกครั้งที่เปิดหน้า (ไม่ cache)
- **Stats Cards**: จำนวนครั้งฟอก, จำนวนผู้ป่วย, ค่า UF เฉลี่ย, ค่าฟอกรวม
- **ตัวกรอง**:
  - ช่วงวันที่ฟอก (พร้อม preset: วันนี้ / 7 วัน / 30 วัน / เดือนนี้ / เดือนที่แล้ว / ปีนี้)
  - สิทธิการรักษา (สร้าง dropdown อัตโนมัติจากข้อมูล)
  - ค้นหา HN / ชื่อ / เลขบัตรประชาชน
- **ตารางทะเบียน 16 คอลัมน์**: HN, ชื่อ-สกุล+CID, อายุ, สิทธิ, วันที่/เวลา, น้ำหนัก ก่อน/หลัง, BP ก่อน/หลัง, UF, URR, Kt/V, Hb/Hct, Vascular, ค่าฟอก
- **Modal รายละเอียด** 6 sections: การฟอกไต / ความดัน / Lab / Vascular Access / ยา / ค่าใช้จ่าย
- **Export CSV** (UTF-8 BOM รองรับภาษาไทยใน Excel)
- **Print-friendly** (ซ่อน UI ที่ไม่จำเป็น)

## 🚀 การใช้งาน

### วิธีที่ 1: เปิดไฟล์ตรงๆ

```
ดับเบิลคลิก index.html
```

ระบบจะเปิดหน้า Login ให้กรอก BMS Session ID

### วิธีที่ 2: Local Server (แนะนำ — แก้ปัญหา CORS)

```bash
# Python 3
python -m http.server 8080

# หรือ Node.js
npx serve .
```

แล้วเปิด http://localhost:8080/

### วิธีที่ 3: ส่ง Session ID ผ่าน URL (one-shot)

```
http://localhost:8080/?bms-session-id=YOUR_SESSION_ID
```

ระบบจะตรวจ session กับ API แล้วลบ parameter ออกจาก URL  
**ไม่บันทึก** ลง LocalStorage หรือ Cookie — ถ้า refresh หน้าจะกลับไปหน้า login อีกครั้ง

## 🔑 การหา BMS Session ID

1. เปิด HOSxP / BMS Dashboard ในเบราว์เซอร์ที่ login แล้ว
2. ดู URL: `?bms-session-id=...`
3. หรือเปิด DevTools → Application → Cookies → `bms-session-id`

Session ของ HOSxP มีอายุประมาณ 10 ชั่วโมง  
แต่ระบบนี้บังคับ verify กับ API **ทุกครั้งที่เปิดหน้า** เพื่อความปลอดภัย — ไม่ใช้ session ที่ cache ไว้

## 🏗️ สถาปัตยกรรม

```
[Browser]
   │
   ├─ ตรวจ Session ─────────────► https://hosxp.net/phapi/PasteJSON
   │                              ↳ ได้ apiUrl + apiAuthKey
   │
   └─ Query SQL ────────────────► {apiUrl}/api/sql
                                  ↳ Authorization: Bearer {apiAuthKey}
```

## 📦 Tech Stack

- HTML / Vanilla JavaScript (ไม่มี build step)
- TailwindCSS (CDN)
- Google Fonts: Sarabun + Prompt
- BMS HOSxP API

## ⚠️ หมายเหตุ

- ไฟล์นี้ **ไม่มี Session ID หรือ API URL hardcoded** — ต้องกรอกตอน login
- ตัว query กรองเฉพาะ `clinic='009'` (ฟอกไต) — ปรับได้ในฟังก์ชัน `buildSQL()` ใน [index.html](index.html)
- หากเปิดผ่าน `file://` แล้วเจอ CORS ให้เปิดผ่าน local server แทน

## 📄 License

MIT

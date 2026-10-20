# ติดตั้งปลั๊กอิน 9sync ใน Obsidian

ติดตั้งและทดสอบ [เซิร์ฟเวอร์](INSTALL-VPS.md) ให้ `/api/health` ตอบก่อน และสำรอง Vault ทั้งสองฝั่งก่อนซิงก์ครั้งแรก

## 1. เตรียมไฟล์ปลั๊กอิน

ต้องมีไฟล์ชุดเดียวกัน 3 ไฟล์: `main.js`, `manifest.json`, `styles.css`

### วิธี A: ใช้ ZIP ที่ build แล้ว

ดาวน์โหลด `9sync-plugin-0.5.0.zip` จาก GitHub Releases หากเจ้าของ repo ออก Release แล้ว ภายในมีโฟลเดอร์ `nine-sync` และไฟล์ทั้งสาม

### วิธี B: Build จาก source

บนคอมพิวเตอร์ที่มี Node.js 22 และ npm เปิด terminal ที่ **ราก repo**:

```bash
npm ci
npm run package:plugin
```

ZIP อยู่ที่ `artifacts/release/9sync-plugin-0.5.0.zip` และไฟล์สำหรับติดตั้งอยู่ที่ `artifacts/release/main.js`, `manifest.json`, `styles.css`

## 2. คัดลอกลง Vault

ปิดปลั๊กอินเดิมก่อน แล้วจัดโครงสร้างเป็น:

```text
YourVault/
└── .obsidian/
    └── plugins/
        └── nine-sync/
            ├── main.js
            ├── manifest.json
            └── styles.css
```

แตก ZIP ลงใน `.obsidian/plugins/` โดยตรง อย่าให้ซ้อนเป็น `nine-sync/nine-sync/main.js` และอย่าลบ `data.json` เดิมเมื่ออัปเดต เพราะเก็บการตั้งค่า/token ของเครื่องนั้น

เปิด Obsidian → Settings → Community plugins → ปิด Restricted mode หากยังเปิดอยู่ → เปิด **9sync** หากยังไม่ปรากฏ ให้ปิด/เปิด Obsidian ใหม่

บนมือถือใช้ไฟล์ชุดเดียวกัน แต่ต้องคัดลอกเข้า Vault บนอุปกรณ์นั้นเอง การซิงก์จากมือถือขึ้นกับการเปิดแอปและข้อจำกัดของระบบปฏิบัติการ ยังไม่รับรองการซิงก์เบื้องหลังตอนปิดแอป

## 3. ตั้งค่าเครื่องแรก

ไป Settings → 9sync:

| ช่อง | ตัวอย่าง / คำอธิบาย |
|---|---|
| Server URL | `https://sync.example.com` หรือ `http://localhost:3001` เมื่อใช้ tunnel บนคอมพิวเตอร์เครื่องนั้น |
| User name | ชื่อข้างเคอร์เซอร์ ไม่ใช่บัญชียืนยันตัวตน |
| Sync scope | `Entire vault` หรือ `Selected folder` |
| Excluded paths | ใช้ `.obsidian`, `.trash`, `.git`, `.9sync` ตามค่าเริ่มต้น |
| Invite code | รหัสเชิญจากเว็บแอดมิน แล้วกด **Join** |

หากยังไม่มี Workspace สร้างจากหน้าแอดมิน หรือกรอก Workspace name แล้วกด Create ในปลั๊กอินได้ ใช้รหัสเชิญให้เครื่องอื่น Join

กด **Restart sync** หลังเปลี่ยน Server URL หรือขอบเขตซิงก์ แถบสถานะควรแสดง `9sync: connected`

## 4. เชื่อมเครื่องที่สอง

1. สร้าง Vault ว่างสำหรับทดสอบก่อน
2. ติดตั้งปลั๊กอินชุดเดียวกัน
3. ใส่ Server URL และรหัสเชิญเดียวกัน → Join
4. ใช้ Sync scope และ Excluded paths ให้สอดคล้องกัน
5. รอรายการไฟล์และไฟล์แนบเข้ามา

Workspace ที่มีข้อมูลจะนำข้อมูลร่วมจากเซิร์ฟเวอร์มาปรับไฟล์ใน Vault ไม่มีหน้าจอ merge ไฟล์ชื่อเดียวกันก่อนซิงก์ จึงควรเริ่มจาก Vault ว่างบนเครื่องที่เพิ่มเข้ามา

## 5. ตรวจการทำงานจริง

1. สร้าง `Notes/Sync-test.md` ที่ A ตรวจว่าปรากฏที่ B
2. เปิดโน้ตเดียวกันทั้งสองเครื่อง พิมพ์ทั้งสองฝั่งและตรวจเคอร์เซอร์
3. แนบรูป/PDF ตรวจว่าไฟล์และลิงก์เปิดได้ทั้งสองเครื่อง
4. เปลี่ยนชื่อและย้ายไฟล์ทดสอบ ตรวจว่าตามกัน
5. ลบ **ไฟล์ทดสอบ** แล้วตรวจว่าการลบตามไปด้วย
6. เปิด Command palette → **9sync: Version history / Restore files** → เลือกไฟล์ที่ลบ → เลือกเวอร์ชัน → Restore → Confirm
7. ตรวจว่าไฟล์กู้คืนและเนื้อหาตรงกันทั้งสองเครื่อง

## ประวัติเวอร์ชันและ checkpoint

เปิดได้ผ่าน Command palette, คลิกขวาไฟล์ → Version history หรือ Settings → 9sync → Open history

- ค้นหา path รวมไฟล์ที่ลบแล้ว
- ใส่ข้อความแล้วกด Save checkpoint เพื่อบันทึกจุดสำคัญ
- เปรียบเทียบกับสถานะปัจจุบันหรืออีกเวอร์ชัน
- Restore กู้ทั้งเนื้อหาและ path และเก็บเวอร์ชันก่อน restore
- ถ้าไฟล์เปลี่ยนแล้ว ให้โหลดประวัติใหม่ ตรวจ diff ก่อนกู้คืนอีกครั้ง
- เว็บแอดมินดาวน์โหลดแต่ละเวอร์ชันได้

## จัดไฟล์แนบอัตโนมัติ

เมื่อเปิด Organize attachments automatically: รูป → `Assets/Images`, PDF → `Assets/PDF`, เสียง/วิดีโอ → `Assets/Media`, อื่น ๆ → `Assets/Files` ถ้าชื่อซ้ำจะเติม `-1`, `-2` ส่วน `.md`, `.canvas`, `.base` ไม่ถูกย้ายด้วยระบบนี้

ระหว่างทดสอบให้ปิด Relay ใน Vault เดียวกันเพื่อหลีกเลี่ยงการ bundle Yjs ซ้ำ ดู [TROUBLESHOOTING.md](TROUBLESHOOTING.md) หากพบปัญหา

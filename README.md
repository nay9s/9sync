# 9sync v0.5.0

ปลั๊กอิน Obsidian สำหรับซิงก์ Vault, แก้ไข Markdown ร่วมกันแบบ realtime และเก็บประวัติเวอร์ชันรายไฟล์ ผ่านเซิร์ฟเวอร์ที่ติดตั้งเอง มีเว็บแอดมินสำหรับจัดการ Workspace และไฟล์

## เริ่มจากตรงไหน

| ต้องการทำอะไร | คู่มือ |
|---|---|
| ติดตั้งเซิร์ฟเวอร์บน Ubuntu VPS | [ติดตั้ง VPS ทีละขั้น](docs/INSTALL-VPS.md) |
| ติดตั้งปลั๊กอินและเชื่อม Vault | [ติดตั้ง Obsidian plugin](docs/INSTALL-PLUGIN.md) |
| อัปเดต สำรอง และกู้ข้อมูล | [ดูแลระบบ](docs/OPERATIONS.md) |
| อัปโหลดโค้ดขึ้น GitHub / ออก Release | [เตรียม GitHub](docs/GITHUB.md) |
| แก้ปัญหาที่พบบ่อย | [แก้ปัญหา](docs/TROUBLESHOOTING.md) |
| แก้ไขโค้ดและรันทดสอบ | [พัฒนาโปรเจกต์](CONTRIBUTING.md) |

**VPS ที่มี Docker และ Compose แล้ว เริ่มที่ขั้นที่ 2 ใน [INSTALL-VPS.md](docs/INSTALL-VPS.md)**

## ความสามารถ

- ซิงก์ทั้ง Vault หรือเฉพาะโฟลเดอร์ พร้อมรายการ exclude
- แก้ไข Markdown พร้อมกันผ่าน Yjs CRDT และแสดงเคอร์เซอร์ผู้ร่วมงาน
- ซิงก์รูป PDF และไฟล์แนบผ่าน HTTP + SHA-256 blob storage
- ซิงก์การสร้าง ย้าย เปลี่ยนชื่อ และลบไฟล์/โฟลเดอร์
- จัดไฟล์แนบใหม่ไป `Assets/Images`, `Assets/PDF`, `Assets/Media`, `Assets/Files`
- เก็บเวอร์ชันอัตโนมัติ, checkpoint พร้อมข้อความ, diff รายบรรทัด และ restore
- กู้ไฟล์ที่ลบแล้ว เก็บสถานะก่อน restore และตรวจว่ามีใครแก้ไฟล์เพิ่มก่อนยอมให้ restore
- เว็บแอดมิน: login, จัดการ Workspace/รหัสเชิญ, ระงับ/เพิกถอนสิทธิ์, จัดการไฟล์, ประวัติกิจกรรมและเวอร์ชัน

## ภาพรวมระบบ

```text
Obsidian A ── WebSocket / HTTP ──┐
                                │
                        Caddy HTTPS (ทางเลือก)
                                │
                         9sync Server :3001
                                │
Obsidian B ── WebSocket / HTTP ──┘
                                ├── PostgreSQL: Workspace, เอกสาร, ประวัติเวอร์ชัน, แอดมิน
                                └── Blob volume: รูป / PDF / ไฟล์แนบ
```

ไฟล์ยังถูกเก็บไว้ใน Vault แต่ละเครื่อง เซิร์ฟเวอร์เป็นตัวกลางสำหรับซิงก์และเก็บข้อมูลร่วมกัน

## เปิดเซิร์ฟเวอร์อย่างย่อ

รันบน **Ubuntu VPS** ภายในโฟลเดอร์โปรเจกต์ หลังติดตั้ง Docker แล้ว:

```bash
bash scripts/setup-env.sh
nano .env
sudo docker compose up -d --build --wait
curl -fsS http://127.0.0.1:3001/api/health
```

`setup-env.sh` สร้างรหัสแอดมิน รหัสฐานข้อมูล และ server secret แบบสุ่ม ดูค่าจริงใน `.env` ที่เครื่องของคุณ ไฟล์นี้ไม่ถูกส่งขึ้น GitHub และสคริปต์ไม่เขียนทับไฟล์ที่มีอยู่

ค่าเริ่มต้นเปิดพอร์ต 3001 **เฉพาะ localhost ของ VPS** ใช้ SSH tunnel เพื่อทดลองจากคอมพิวเตอร์ หรือทำ HTTPS ตามคู่มือ ก่อนให้เครื่องอื่นเชื่อมต่อผ่านอินเทอร์เน็ต

เมื่อมีโดเมนและตั้ง DNS แล้ว กำหนด `NINESYNC_DOMAIN=sync.example.com` ใน `.env` และเปิดชุด HTTPS:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml up -d --build --wait
```

เว็บแอดมิน: `https://sync.example.com/admin/` · Server URL ในปลั๊กอิน: `https://sync.example.com`

## โครงสร้างไฟล์

```text
.github/workflows/       CI และสร้าง GitHub Release เมื่อ push tag
deploy/Caddyfile         Reverse proxy และ HTTPS
docs/                    คู่มือติดตั้งและดูแลระบบภาษาไทย
plugin/src/              ซอร์สปลั๊กอิน Obsidian
plugin/manifest.json     ID nine-sync / version / minimum app version
plugin/styles.css        รูปแบบปลั๊กอิน
server/src/              HTTP API, Yjs, admin, version control และ migrations
server/public/           หน้าเว็บแอดมิน
server/test/             API, version control และ WebSocket integration tests
scripts/                 ติดตั้ง Docker, สร้าง .env, backup, restore และจัด ZIP
docker-compose.yml      PostgreSQL + 9sync (พอร์ต loopback)
compose.https.yml        เพิ่ม Caddy สำหรับใช้โดเมน HTTPS
.env.example             ชื่อค่าตั้งต้น ไม่มีข้อมูลลับจริง
package-lock.json        ล็อกเวอร์ชัน dependency สำหรับ npm ci และ Docker build
```

ไฟล์ที่สร้างภายหลังจะอยู่ใน `artifacts/`, `backups/`, `server/dist/`, `plugin/main.js` และไม่ถูก commit ขึ้น GitHub

## Version control ทำงานอย่างไร

Markdown บันทึก snapshot หลังหยุดแก้ไข 1 วินาที หรือทุกไม่เกิน 10 วินาทีเมื่อแก้ต่อเนื่อง การเปิดประวัติจะบันทึกสถานะที่กำลังรออยู่ก่อนแสดงผล ไฟล์แนบเก็บ hash ของข้อมูลแต่ละเวอร์ชัน ประวัติตาม file ID จึงยังอยู่แม้ย้าย เปลี่ยนชื่อ หรือลบไฟล์

เปิดใน Obsidian ผ่าน Command palette → **9sync: Version history / Restore files**, คลิกขวาไฟล์ → **9sync: Version history** หรือ Settings → 9sync → **Open history**

นี่เป็นประวัติรายไฟล์ ยังไม่มี Git branches, commit ทั้ง repository หรือ merge requests เวอร์ชันเก็บไว้จนกว่าจะลบ Workspace ไม่มีการล้างอัตโนมัติ และเพิ่มพื้นที่ฐานข้อมูลตามการแก้ไข ข้อมูลก่อนติดตั้ง v0.5.0 จะมีเฉพาะ baseline ที่เซิร์ฟเวอร์มีอยู่ตอนอัปเดต

## ขอบเขตและสถานะการทดสอบ

- เหมาะกับทีมที่ไว้ใจกัน: ใช้ token ร่วมต่อ Workspace ยังไม่มีสิทธิ์รายสมาชิกหรืออ่านอย่างเดียว ดู [SECURITY.md](SECURITY.md)
- `.canvas` และ `.base` ซิงก์เป็นไฟล์ทั้งก้อน ไม่ได้รวมการแก้ไขพร้อมกันแบบ Markdown
- ไม่ซิงก์ `.obsidian`, `.trash`, `.git`, `.9sync` เป็นค่าเริ่มต้น
- เป็นระบบซิงก์ ไม่ทดแทน backup: การลบไฟล์ตามไปยังเครื่องที่เชื่อมต่อ การลบ Workspace ลบประวัติถาวร
- มีการตรวจ build, SQL/API ด้วย PGlite และการ restore ผ่าน WebSocket จริงไปยังสองไคลเอนต์ พร้อมทดสอบเว็บแอดมินในเบราว์เซอร์
- ยังต้องยืนยันการใช้งานกับ Vault/อุปกรณ์ Obsidian จริงของคุณ และทดสอบ Docker/HTTPS บน VPS ปลายทาง

ประวัติรุ่น: [CHANGELOG.md](CHANGELOG.md)
"# 9sync" 

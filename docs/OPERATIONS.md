# อัปเดต สำรอง และกู้ข้อมูล

คำสั่งรันที่รากโปรเจกต์บน VPS ใช้ `sudo docker ...` หากบัญชีไม่มีสิทธิ์ Docker โดยตรง

## ตรวจสถานะและ log

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 server postgres
curl -fsS http://127.0.0.1:3001/api/health
```

สำหรับ Caddy:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml logs --tail=100 caddy
```

## สำรองก่อนอัปเดต

```bash
sudo bash scripts/backup.sh
```

สคริปต์หยุด `server` ชั่วคราวเพื่อให้ฐานข้อมูลกับไฟล์แนบอยู่ในช่วงเวลาเดียวกัน และเปิด server กลับหากเดิมทำงานอยู่ เก็บไว้ที่ `backups/<เวลา-UTC>-<PID>/`:

| ไฟล์ | เนื้อหา |
|---|---|
| `database.dump` | PostgreSQL รวมเอกสาร แอดมิน ประวัติกิจกรรมและเวอร์ชัน |
| `blobs.tar.gz` | ไฟล์แนบทุก hash |
| `server.env` | สำเนาค่าลับจาก `.env` |
| `SHA256SUMS` | checksum สำหรับตรวจไฟล์ครบ |
| `COMPLETE` | มีเฉพาะเมื่อสำรองทุกส่วนสำเร็จ |

ไฟล์สำรองมีข้อมูลส่วนตัวและรหัสผ่าน เก็บนอก VPS อีกชุดด้วย **ไม่อัปโหลด `backups/` หรือ `server.env` ขึ้น GitHub** หากสำรองล้มเหลว จะไม่มี `COMPLETE` และไม่ควรใช้ชุดนั้นกู้คืน การเปิด server กลับจาก trap ไม่ได้แปลว่าการสำรองสำเร็จ

## อัปเดตเซิร์ฟเวอร์

สำรองก่อน จากนั้น:

```bash
git pull --ff-only
sudo docker compose up -d --build --wait
curl -fsS http://127.0.0.1:3001/api/health
```

ถ้าใช้ HTTPS ต้องใช้ชุดไฟล์เดิมด้วยทุกครั้งที่สร้าง/recreate server:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml up -d --build --wait
curl -fsS https://sync.example.com/api/health
```

การใช้เฉพาะ base file อาจเปลี่ยน secure cookie กลับเป็น false และไม่จัดการ Caddy จึงควรใช้รูปแบบเดิมให้สม่ำเสมอ

เก็บ `.env`, ชื่อ Compose project และโฟลเดอร์ deploy เดิมไว้ การเปลี่ยนชื่อโฟลเดอร์หรือใช้ `-p` ต่างจากเดิมอาจทำให้ Compose เลือกคนละชุด volumes อย่าใช้ `down -v` และอย่าลบ volume เมื่อแค่อัปเดตโปรแกรม

## อัปเดตปลั๊กอิน

ติดตั้ง `main.js`, `manifest.json`, `styles.css` จาก release เดียวกัน แล้วปิด/เปิดปลั๊กอินใหม่ เก็บ `data.json` ของแต่ละ Vault ไว้ ดู [INSTALL-PLUGIN.md](INSTALL-PLUGIN.md)

## ย้ายจาก Compose รุ่นก่อนชุด GitHub-ready

Compose เดิมอาจมีรหัสฐานข้อมูลเป็น `ninesync` และเปิดพอร์ต 3001 ทุก interface ชุดนี้เพิ่ม `NINESYNC_DB_PASSWORD` และเปลี่ยนเป็นพอร์ต loopback:

1. สำรองข้อมูลก่อนแก้ config
2. ตั้ง `NINESYNC_DB_PASSWORD` ใน `.env` ให้ตรงกับรหัสฐานข้อมูลเดิมจริง ๆ หากไม่เคยเปลี่ยนจาก Compose เก่า ค่าคือ `ninesync`
3. อย่าตั้งรหัสใหม่ใน environment อย่างเดียวแล้วคาดว่า PostgreSQL volume เดิมจะเปลี่ยนตาม ตัวแปร `POSTGRES_PASSWORD` ใช้ตอนสร้างฐานข้อมูลครั้งแรก
4. เก็บ `NINESYNC_SERVER_SECRET` เดิมไว้ เพื่อไม่ให้ token ทุกเครื่องใช้ไม่ได้
5. ถ้าต้องการเปลี่ยนรหัส PostgreSQL ต้องเปลี่ยนในฐานข้อมูลและ `.env` ให้ตรงกันในช่วงบำรุงรักษา
6. เปลี่ยน URL ของ client เป็น HTTPS หรือเปิด tunnel เพราะพอร์ต 3001 ไม่เปิดสาธารณะแล้ว

## กู้คืน backup

การกู้คืน **แทนที่ฐานข้อมูลและไฟล์แนบปัจจุบัน** ไม่ใช่การ merge สำรองระบบปัจจุบันก่อนถ้ามีข้อมูลที่ต้องเก็บ ปิด Obsidian ที่เชื่อมต่ออยู่ระหว่างกู้คืน เพื่อไม่ให้ client ส่งสถานะใหม่กลับเข้ามาทันที

### กู้บน VPS ใหม่

1. Clone repo และติดตั้ง Docker ตามคู่มือ
2. ส่งโฟลเดอร์ backup ที่มี `COMPLETE` มายัง VPS อย่างปลอดภัย
3. ใช้สำเนา environment เดิมก่อนสร้าง PostgreSQL volume ใหม่:

```bash
sudo install -m 600 /absolute/path/to/backup/server.env .env
```

ปรับ `NINESYNC_DOMAIN` ถ้าต้องเปลี่ยนโดเมน แต่รักษา server secret เดิม และรหัสฐานข้อมูลต้องตรงกับ PostgreSQL ที่ใช้

4. Build image ก่อนใช้คำสั่ง restore:

```bash
sudo docker compose build server
sudo bash scripts/restore-backup.sh /absolute/path/to/backup --confirm-restore
```

5. ถ้าใช้ HTTPS เปิดชุด Caddy อีกครั้ง:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml up -d --wait
```

6. ตรวจ health, login แอดมิน, เปิดไฟล์/รูปจากเว็บ และประวัติเวอร์ชัน ก่อนให้ Vault ทดสอบเชื่อมต่อ

### กู้บน VPS เดิม

ใช้ `.env` ปัจจุบันที่ตรงกับฐานข้อมูลเดิมและ server secret ของ backup แล้วรัน `restore-backup.sh` เหมือนด้านบน สคริปต์ตรวจ checksum ก่อน หยุด server แล้วจึง restore หากล้มเหลวจะไม่เปิด server กลับอัตโนมัติ ให้ตรวจ log และสาเหตุก่อนเริ่มใหม่

## แอดมินและสิทธิ์

- เปลี่ยนรหัสแอดมินในหน้า **ตั้งค่าระบบ** จะยกเลิกทุกเซสชันแอดมิน
- เปลี่ยนรหัสเชิญ ป้องกันการ Join ด้วยรหัสเก่า แต่ไม่ตัดเครื่องที่เชื่อมต่ออยู่
- **เพิกถอนสิทธิ์ทั้งหมด** ตัดทุกเครื่องและเปลี่ยน token/รหัสเชิญ ต้อง Join ใหม่
- **ระงับ Workspace** หยุดการเชื่อมต่อของ Workspace นั้น
- ลบไฟล์ยังมีประวัติให้ restore แต่ **ลบ Workspace ลบประวัติถาวรด้วย**

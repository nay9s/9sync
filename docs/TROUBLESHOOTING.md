# แก้ปัญหาที่พบบ่อย

## docker: permission denied ที่ /var/run/docker.sock

ใช้ `sudo docker ps` และ `sudo docker compose ...` ตามคู่มือ ไม่ใช่ปัญหาว่า Docker ติดตั้งไม่สำเร็จ

## docker-ce ไม่มี installation candidate

ตรวจว่ามี Repository ของ Docker จริง:

```bash
cat /etc/os-release
cat /etc/apt/sources.list.d/docker.sources
sudo apt update
```

ผล update ต้องเห็น `download.docker.com` ถ้าไม่มีไฟล์ source ใช้ `sudo bash scripts/install-docker-ubuntu.sh` หลัง clone repo และตรวจ error ของ apt ก่อนติดตั้งต่อ

## Compose บอกให้ตั้ง environment variable

รัน `bash scripts/setup-env.sh` ครั้งแรก หรือเติมค่าที่หายไปใน `.env` ที่ราก repo ต้องมี DB password, server secret และรหัสแอดมิน ห้ามใส่ไฟล์นี้ใน `server/` แทนราก repo

อย่าแชร์ผล `docker compose config` ทั้งชุด เพราะคำสั่งอาจแสดงค่าลับ ถ้าตรวจแค่รูปแบบใช้ `sudo docker compose config --quiet`

## PostgreSQL: password authentication failed

`NINESYNC_DB_PASSWORD` ไม่ตรงกับรหัสที่ใช้สร้าง volume เดิม การเปลี่ยน `.env` อย่างเดียวไม่เปลี่ยนรหัสใน PostgreSQL อย่าลบ volume เพื่อแก้ปัญหา ให้ใช้รหัสเดิมหรือเปลี่ยนรหัสในฐานข้อมูลอย่างถูกต้อง ดู [OPERATIONS.md](OPERATIONS.md)

## เข้า IP:3001 จากอินเทอร์เน็ตไม่ได้

ชุดนี้ตั้งให้พอร์ต 3001 เปิดเฉพาะ localhost ของ VPS เป็นค่าเริ่มต้น ใช้ SSH tunnel หรือ HTTPS ตาม [INSTALL-VPS.md](INSTALL-VPS.md) ไม่ต้องเปลี่ยน Compose ให้เปิดทุก interface เพื่อแก้กรณีนี้

## localhost ใช้ได้บนคอมพิวเตอร์ แต่ใช้บนมือถือไม่ได้

`localhost` คืออุปกรณ์ที่กำลังใช้ URL นั้น มือถือไม่ได้เชื่อม tunnel ของคอมพิวเตอร์อัตโนมัติ ให้ใช้โดเมน HTTPS เดียวกันที่เข้าถึงได้จากทั้งสองเครื่อง

## Caddy ขอใบรับรองไม่ได้

ตรวจ DNS A/AAAA, พอร์ต 80/443 และ log:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml logs --tail=100 caddy
```

ใช้ hostname จริง ไม่ใส่ URL/IP ใน `NINESYNC_DOMAIN` และตรวจว่าไม่มีเว็บเซิร์ฟเวอร์อื่นใช้พอร์ตเดียวกัน

## แอดมิน login ไม่ได้

ชื่อ/รหัสตั้งตอนสร้างบัญชีครั้งแรกจาก `.env` เปลี่ยนตัวแปรนี้ภายหลังไม่เปลี่ยนบัญชีเดิม หาก login ผ่าน HTTPS ให้ใช้ Compose overlay HTTPS ให้ครบ ถ้าใช้ tunnel HTTP และเคยตั้ง secure cookie เอง ให้ตรวจ `NINESYNC_COOKIE_SECURE` ให้ตรงกับวิธีเข้าถึง

## Plugin ค้าง connecting

1. ทดสอบ `/api/health` จากอุปกรณ์ที่ใช้ปลั๊กอิน
2. Server URL ต้องเป็น URL ราก ไม่ลงท้าย `/admin/`, `/api`, `/ws`
3. ตรวจ invite code, Workspace ID และ Workspace ไม่ได้ถูกระงับ
4. ถ้าแอดมินเพิกถอนสิทธิ์ ต้อง Join ใหม่ด้วยรหัสเชิญใหม่
5. ใช้ reverse proxy ที่รองรับ WebSocket แล้วกด Restart sync

## ไม่เห็นเมนู Version history / API 404

อัปเดตทั้ง server และ plugin เป็น v0.5.0 ตรวจ `health.version` และ `manifest.json` ติดตั้งไฟล์ทั้งสามจาก release เดียวกัน แล้วปิด/เปิดปลั๊กอิน

## Restore แจ้ง conflict

มีการแก้ไฟล์หลังเปิดประวัติ หรือ path เก่ามีไฟล์อื่นใช้อยู่ โหลดประวัติใหม่ ตรวจ diff และแก้ path ที่ชนก่อน กรณีนี้ระบบตั้งใจปฏิเสธการทับข้อมูล

## ไฟล์เด้งกลับหรือปลั๊กอินอื่น error

ปิดระบบซิงก์อื่นใน Vault ทดสอบเดียวกัน โดยเฉพาะ Relay ที่ bundle Yjs อีกชุด หากมี error จาก Kanban/ปลั๊กอินอื่น ให้ปิดปลั๊กอินนั้นชั่วคราวแล้วทดสอบกับ Vault ว่าง 9sync มี recovery scan ทุก 2.5 วินาที แต่ไม่รับรองว่าจะซ่อม event ที่หายทุกกรณี

## ต้องส่งข้อมูลอะไรเมื่อแจ้งปัญหา

เวอร์ชัน server/plugin, OS, ขั้นตอนทำซ้ำ, error ที่ตรงเวลาเกิดปัญหา และไฟล์ทดสอบที่ไม่เป็นความลับ ปิด token, cookie, password, invite code และข้อมูล Vault ส่วนตัวก่อนแชร์ log

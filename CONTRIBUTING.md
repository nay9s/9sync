# พัฒนา 9sync

ใช้ Node.js 22 และ npm จากราก repo:

```bash
npm ci
npm run build
npm test
```

`npm test` ใช้ PGlite ซึ่งรัน PostgreSQL engine ในหน่วยความจำและทดสอบ HTTP API/การ restore ผ่าน Yjs WebSocket จริง ไม่ต้องติดตั้ง PostgreSQL เพื่อรันทดสอบเหล่านี้ แต่การรันเซิร์ฟเวอร์ปกติต้องมี PostgreSQL

## รันปลั๊กอินระหว่างพัฒนา

```bash
npm run dev:plugin
```

คำสั่ง watch จะสร้าง `plugin/main.js` ให้คัดลอกพร้อม manifest/styles เข้า Vault ทดสอบ แยกจาก Vault ข้อมูลจริง

## รัน server ด้วย Node โดยตรง

ตัวแปร Compose ใน `.env.example` ไม่ใช่ `DATABASE_URL` ของ Node process ถ้าจะรันโดยไม่ใช้ server container ต้องตั้งค่า process เองให้เข้าถึง PostgreSQL ที่คุณจัดเตรียมไว้:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE'
export NINESYNC_SERVER_SECRET='your-existing-server-secret'
export NINESYNC_ADMIN_USERNAME='admin'
export NINESYNC_ADMIN_PASSWORD='your-initial-admin-password'
npm run dev:server
```

ไม่ต้องเปิดพอร์ต PostgreSQL ใน production Compose เพื่อใช้ตัวอย่างนี้ ให้ใช้ฐานข้อมูลสำหรับ development แยกต่างหาก

## จัดแพ็ก

```bash
npm run package:plugin
npm run package:repo
```

รายการ source ใน `scripts/package-repository.mjs` เป็น allowlist เพื่อไม่ให้ไฟล์ Vault, secret และ artifacts ติดไป ตรวจและเพิ่มรายการเมื่อเพิ่มโฟลเดอร์ source ใหม่

คำสั่ง npm และ Docker ใน CI อ้างอิง root `package-lock.json` เดียวกัน หากเปลี่ยน dependencies ให้ commit lockfile ด้วย

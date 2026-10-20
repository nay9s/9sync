# เตรียมไฟล์ขึ้น GitHub และสร้าง Release

ขั้นตอนนี้เตรียม source ในเครื่องก่อน ยังไม่สร้าง repo หรือส่งข้อมูลขึ้น GitHub จนกว่าคุณจะทำขั้น push เอง

## ไฟล์ที่ควรขึ้น GitHub

ใช้ source folder ที่สร้างจาก `npm run package:repo` หรือราก repo ที่มี `.gitignore` ชุดนี้ จะรวม source, คู่มือ, Compose, Dockerfile, scripts และ workflows

ไม่รวม `.env`, `.obsidian`, Vault, `node_modules`, ฐานข้อมูล, blob storage, backups, screenshot ทดสอบ หรือ ZIP ที่ build แล้ว ปลั๊กอินที่ build แล้วแนบผ่าน GitHub Releases แยกจาก source

## 1. ตรวจและสร้างชุดไฟล์ในเครื่อง

ต้องมี Node.js 22 และ npm เปิด terminal ที่รากโปรเจกต์:

```bash
npm ci
npm test
npm run package:plugin
npm run package:repo
```

ผลลัพธ์:

- `artifacts/release/`: ไฟล์ติดตั้งปลั๊กอิน 3 ไฟล์, ZIP และ checksum
- `artifacts/github-ready/9sync-github-ready-0.5.0.zip`: source ที่พร้อมอัปโหลด
- source folder ที่คำสั่งแสดง: เปิดด้วย editor หรือ GitHub Desktop ได้

ZIP source มีโฟลเดอร์ `9sync/` ภายใน แตกไฟล์ก่อนนำเข้า GitHub Desktop/ใช้ git อย่าอัปโหลดเฉพาะไฟล์ ZIP ลง repo แล้วคาดว่าจะ clone/build ได้

## 2. สร้าง GitHub repo ว่าง

บน GitHub เลือก New repository ตั้งชื่อ เช่น `9sync` เลือก private/public ตามต้องการ ถ้าจะ push source ที่มีอยู่แล้ว ให้เริ่มด้วย repo ว่าง ไม่ต้องสร้าง README ซ้ำบน GitHub

## 3. Push source

เปิด terminal ใน source folder ที่จัดไว้ หรือรากโปรเจกต์ที่มี `.gitignore` แล้วตรวจรายการไฟล์ก่อน commit:

```bash
git init -b main
git add .
git status --short
```

รายการไม่ควรมี `.env`, `.obsidian`, `node_modules`, `backups` หรือ `artifacts` จากนั้น:

```bash
git commit -m "Prepare 9sync v0.5.0"
git remote add origin https://github.com/YOUR_USER/9sync.git
git push -u origin main
```

เปลี่ยน `YOUR_USER` ให้ตรงกับเจ้าของ repo หาก Git ขอชื่อผู้เขียน ให้ตั้ง `git config user.name` และ `git config user.email` ภายใน repo นี้ก่อน commit ใช้การล็อกอิน GitHub ผ่าน credential manager/SSH key ของคุณ ไม่ใส่รหัสหรือ token ลง source

หากใช้ GitHub Desktop: Add local repository → เลือก source folder → ตรวจ Changes → Commit → Publish repository

## 4. ตรวจ CI

แท็บ Actions จะรัน `.github/workflows/ci.yml`: ติดตั้งด้วย `npm ci`, ทดสอบ server, build plugin, ตรวจ Compose/shell, build Docker image และเปิดชุด Docker ชั่วคราวเพื่อทดสอบ login/ซิงก์/restore จริง พร้อมแนบ artifact ปลั๊กอิน

CI ที่เขียนไว้เป็นขั้นตอนที่จะรันหลัง push การมี workflow ใน source ไม่ได้แปลว่า CI บน GitHub ผ่านแล้ว ต้องดูผลใน Actions จริง

## 5. ออก Release v0.5.0

เมื่อ commit และ CI พร้อมแล้ว:

```bash
git tag v0.5.0
git push origin v0.5.0
```

workflow `release.yml` ตรวจ tag ให้ตรง `plugin/manifest.json`, ทดสอบ/build แล้วสร้าง GitHub Release พร้อม:

- `main.js`, `manifest.json`, `styles.css`
- `9sync-plugin-0.5.0.zip` มีโฟลเดอร์ `nine-sync/` สำหรับติดตั้ง
- `SHA256SUMS`

ไม่ต้องสร้าง GitHub token ใส่ไฟล์ workflow ใช้ `GITHUB_TOKEN` ของงานนั้น หากองค์กรปิดสิทธิ์ Actions ต้องเปิดให้ workflow เขียน contents เพื่อสร้าง Release ก่อน

เมื่อ source อยู่บน GitHub แล้ว ใช้ URL repo ของคุณใน [คู่มือติดตั้ง VPS](INSTALL-VPS.md)

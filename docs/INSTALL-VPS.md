# ติดตั้ง 9sync บน Ubuntu VPS

คู่มือนี้ใช้ Ubuntu 24.04/26.04 และ Docker Compose แบบ `docker compose` ไม่จำเป็นต้องติดตั้ง Node.js บน VPS เพราะ build ภายใน Docker

คำสั่งรันใน **SSH ของ VPS** ยกเว้นบล็อก Windows PowerShell เปลี่ยน `YOUR_USER`, `VPS_IP`, `sync.example.com` เป็นค่าจริง

## 1. ตรวจ Docker

```bash
sudo docker ps
sudo docker compose version
```

ถ้าแสดงตารางและเวอร์ชัน ให้ข้ามไปขั้น 2 หากยังไม่มี Docker ใช้ [คู่มือทางการ](https://docs.docker.com/engine/install/ubuntu/) หรือหลังดาวน์โหลด repo ในขั้น 2 แล้วรัน:

```bash
sudo bash scripts/install-docker-ubuntu.sh
```

สคริปต์ใช้ Repository ทางการของ Docker และหยุดเมื่อคำสั่งล้มเหลว หากมีแพ็กเกจ Docker/containerd จากแหล่งอื่นอยู่แล้ว ให้แก้ package conflict ตามคู่มือทางการก่อน

## 2. ดาวน์โหลดโปรเจกต์จาก GitHub

บน VPS:

```bash
sudo apt update
sudo apt install -y git openssl ca-certificates curl
git clone https://github.com/YOUR_USER/9sync.git
cd 9sync
```

หาก repo เป็น private ใช้ SSH key หรือการยืนยันตัวตนที่ GitHub รองรับ ห้ามใส่ token ลงใน URL ที่เก็บในประวัติคำสั่ง

หากยังไม่อัป GitHub สามารถส่ง source ZIP ด้วย `scp` จากคอมพิวเตอร์ แล้วแตกบน VPS ด้วย `unzip` จากนั้น `cd 9sync` ได้เหมือนกัน

## 3. สร้างค่าลับครั้งแรก

```bash
bash scripts/setup-env.sh
nano .env
```

| ค่า | ใช้ทำอะไร |
|---|---|
| `NINESYNC_DB_PASSWORD` | รหัส PostgreSQL เป็น hex เพื่อใช้ใน URL ได้ |
| `NINESYNC_SERVER_SECRET` | ลงลายเซ็น Workspace token; เก็บค่าเดิมเมื่ออัปเดต |
| `NINESYNC_ADMIN_USERNAME` | ชื่อแอดมินเริ่มต้น ค่าเริ่มต้น `admin` |
| `NINESYNC_ADMIN_PASSWORD` | รหัสแอดมินเริ่มต้นแบบสุ่ม อย่างน้อย 12 ตัวอักษร |
| `NINESYNC_PORT` | พอร์ต localhost ของ VPS ค่าเริ่มต้น 3001 |
| `NINESYNC_DOMAIN` | hostname สำหรับ HTTPS; เว้นว่างเมื่อใช้ tunnel |

บันทึกใน nano: `Ctrl+O`, Enter แล้วออกด้วย `Ctrl+X` เก็บรหัสแอดมินไว้ใน password manager

หากมี `.env` สคริปต์จะไม่เขียนทับ อย่าสร้างค่าลับใหม่ทับระบบเดิม การเปลี่ยนตัวแปรรหัสแอดมินภายหลังไม่รีเซ็ตบัญชีเดิม ให้เปลี่ยนจากหน้าเว็บ

## 4. เปิด PostgreSQL และเซิร์ฟเวอร์

```bash
sudo docker compose up -d --build --wait
sudo docker compose ps
curl -fsS http://127.0.0.1:3001/api/health
```

ครั้งแรกดาวน์โหลด image และ build อาจใช้เวลาหลายนาที ผล health ที่คาดหวัง:

```json
{"ok":true,"service":"9sync","version":"0.5.0"}
```

ถ้าเปลี่ยน `NINESYNC_PORT` ให้ใช้พอร์ตนั้นใน `curl` ฐานข้อมูลไม่มีพอร์ตเปิดสู่อินเทอร์เน็ต และ 9sync เปิดพอร์ตเฉพาะ `127.0.0.1` หากไม่พร้อมใช้งาน:

```bash
sudo docker compose logs --tail=100 server postgres
```

## 5A. ยังไม่มีโดเมน: ทดลองผ่าน SSH tunnel

เปิด **Windows PowerShell หน้าต่างใหม่บนคอมพิวเตอร์**:

```powershell
ssh -N -L 3001:127.0.0.1:3001 ubuntu@VPS_IP
```

ปล่อยหน้าต่างนี้เปิดไว้ เมื่อสำเร็จจะไม่ขึ้น prompt ใหม่ จากนั้นเปิดบนคอมพิวเตอร์:

- เว็บแอดมิน: `http://localhost:3001/admin/`
- Server URL ใน Obsidian เครื่องเดียวกัน: `http://localhost:3001`

เข้าสู่เว็บด้วยชื่อและรหัสใน `.env` บน VPS ต้องเปิด tunnel ไว้ตลอด `localhost` บนมือถือหรือเครื่องอื่นหมายถึงเครื่องนั้นเอง จึงไม่ใช่ URL สำหรับให้ทุกอุปกรณ์ใช้ร่วมกัน

หากคอมพิวเตอร์ใช้พอร์ต 3001 อยู่แล้ว เปลี่ยนฝั่งซ้ายเป็น 13001:

```powershell
ssh -N -L 13001:127.0.0.1:3001 ubuntu@VPS_IP
```

แล้วใช้ `http://localhost:13001` บนคอมพิวเตอร์

## 5B. ใช้งานหลายอุปกรณ์: เปิด HTTPS ด้วยโดเมน

1. สร้าง DNS record **A** เช่น `sync.example.com` ชี้ IPv4 ของ VPS
2. ถ้าสร้าง AAAA ต้องชี้ IPv6 ที่เข้าถึง VPS ได้จริง มิฉะนั้นยังไม่เพิ่ม AAAA
3. ให้ TCP 80 และ 443 เข้าถึง VPS ได้ทั้ง firewall ผู้ให้บริการและเครื่อง พอร์ต 22 ต้องคงไว้สำหรับ SSH
4. ถ้ามีบริการใช้ 80/443 อยู่ ต้องใช้ reverse proxy เดิมหรือย้ายบริการก่อนเปิด Caddy

เปิด `.env`:

```bash
nano .env
```

ใส่ hostname โดยไม่มี `https://` และไม่มี `/`:

```dotenv
NINESYNC_DOMAIN=sync.example.com
```

เปิดชุด HTTPS:

```bash
sudo docker compose -f docker-compose.yml -f compose.https.yml up -d --build --wait
sudo docker compose -f docker-compose.yml -f compose.https.yml logs --tail=80 caddy
curl -fsS https://sync.example.com/api/health
```

Caddy ขอและต่ออายุใบรับรองให้ และ reverse proxy รองรับ WebSocket ชุด HTTPS ตั้ง secure cookie ของแอดมินอัตโนมัติ ดู [เอกสาร Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy)

- แอดมิน: `https://sync.example.com/admin/`
- Obsidian Server URL: `https://sync.example.com` **ไม่เติม `/admin/`, `/api` หรือ `/ws`**

Docker published ports อาจข้ามกฎ UFW ตาม [ข้อจำกัด firewall ของ Docker](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations) ชุดนี้จึงไม่เปิดพอร์ต 3001 สู่สาธารณะ ให้ใช้ Caddy 443 หรือ tunnel

## 6. สร้าง Workspace และติดตั้งปลั๊กอิน

1. เข้าหน้าแอดมิน → Workspace → สร้าง Workspace
2. คัดลอกรหัสเชิญไว้สำหรับ Join จากปลั๊กอิน
3. ทำต่อที่ [ติดตั้งปลั๊กอิน Obsidian](INSTALL-PLUGIN.md)

## ข้อมูลอยู่ที่ไหน

Docker named volumes เก็บข้อมูลนอก container: `nine_sync_pg` เก็บฐานข้อมูล และ `nine_sync_blobs` เก็บรูป/PDF/ไฟล์แนบ ชุด HTTPS มี volume ของ Caddy เพิ่มสำหรับใบรับรอง

ชื่อจริงมี Compose project prefix เช่น `9sync_nine_sync_pg` การ rebuild ไม่ลบ volumes แต่ **อย่าใช้ `docker compose down -v` กับระบบที่มีข้อมูล** ดู [คู่มือ backup](OPERATIONS.md) ก่อนอัปเดต

# ขอบเขตการเข้าถึงและข้อมูลลับ

9sync รุ่นนี้เป็น MVP สำหรับกลุ่มผู้ใช้ที่ไว้ใจกัน ไม่ใช่บริการ multi-tenant ที่เปิดให้คนทั่วไปสมัครใช้งาน

- สมาชิก Workspace ใช้ token ร่วม ทุกเครื่องที่มี token มีสิทธิ์ซิงก์ อ่านไฟล์ และใช้ version restore ยังไม่มี role อ่านอย่างเดียวหรือสิทธิ์รายสมาชิก
- การสร้าง Workspace ผ่าน plugin API และการ Join ด้วยรหัสเชิญยังเปิดใช้งานอยู่ จึงควรจำกัดเครือข่าย/ผู้เข้าถึงเมื่อนำบริการไปไว้บนอินเทอร์เน็ต โดยเฉพาะก่อนเปิดให้บุคคลที่ไม่รู้จักใช้งาน
- แอดมินมีสิทธิ์ทุก Workspace; session cookie เป็น HttpOnly/SameSite และชุด HTTPS เปิด Secure cookie
- ข้อมูลบนเซิร์ฟเวอร์ไม่ได้เข้ารหัสแบบ end-to-end ผู้ดูแลเซิร์ฟเวอร์/ฐานข้อมูลอ่านข้อมูลได้ ใช้ HTTPS เพื่อป้องกันการรับส่งและควบคุมการเข้าถึง host/backups
- `NINESYNC_SERVER_SECRET` ต้องคงเดิมเมื่ออัปเดตและย้ายเครื่อง ไม่เผยแพร่ `.env`, `data.json` ของ plugin, invite code, token, cookie หรือ backups
- PostgreSQL ไม่ publish พอร์ต และ API port 3001 bind localhost โดยค่าเริ่มต้น
- การลบ Workspace ลบประวัติถาวร กำหนดและทดสอบ backup ก่อนเก็บข้อมูลสำคัญ

ถ้ารายงานปัญหาความปลอดภัย ให้ใช้ช่องทางส่วนตัวของเจ้าของ repository หรือ GitHub private vulnerability reporting หากเจ้าของเปิดไว้ ไม่แนบรหัสผ่านหรือข้อมูล Vault ใน public issue

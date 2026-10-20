import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Express, Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import * as Y from 'yjs';
import type { VersionControl } from './versions.js';

const scrypt = promisify(crypto.scrypt);
async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`;
}
async function verifyPassword(password: string, hash: string) {
  const [salt, digest] = hash.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(digest, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
export async function migrateAdmin(pool: Pool) {
  await pool.query(`
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS admin_accounts (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES admin_accounts(username), expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events (id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, workspace_id TEXT, detail TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
  `);
  const password = process.env.NINESYNC_ADMIN_PASSWORD;
  if (password) {
    if (password.length < 12) throw new Error('NINESYNC_ADMIN_PASSWORD must contain at least 12 characters');
    await pool.query('INSERT INTO admin_accounts(username, password_hash) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING',
      [process.env.NINESYNC_ADMIN_USERNAME || 'admin', await hashPassword(password)]);
  }
}
export async function audit(pool: Pool, actor: string, action: string, workspaceId?: string, detail = '') {
  await pool.query('INSERT INTO audit_events(actor,action,workspace_id,detail) VALUES ($1,$2,$3,$4)', [actor, action, workspaceId || null, detail.slice(0, 2000)]);
}
type Options = {
  versionControl?: VersionControl;
  pool: Pool;
  disconnect: (id: string) => void;
  getDocument: (name: string) => Promise<Y.Doc>;
  persistDocument: (name: string, doc: Y.Doc) => Promise<void>;
  createWorkspace: (name: string) => Promise<unknown>;
  connections: () => { workspaceId: string; room: string }[];
  downloadBlob: (hash: string, res: Response) => Promise<void>;
};
export function registerAdmin(app: Express, options: Options) {
  const { pool } = options;
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = (req: Request) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('nine_admin='))?.slice(11) || '';
  const sessions = (req: Request) => digest(cookie(req));
  const secure = process.env.NINESYNC_COOKIE_SECURE === 'true' ? '; Secure' : '';
  const writeCookie = (res: Response, token: string, age: number) => res.setHeader('Set-Cookie', `nine_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${age}${secure}`);
  const attempts = new Map<string, { count: number; reset: number }>();
  app.use('/api/admin', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.header('x-nine-admin') !== '1') return res.status(403).json({ error: 'Invalid request origin' });
    next();
  });
  app.post('/api/admin/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    for (const [key, item] of attempts) if (item.reset < now) attempts.delete(key);
    const attempt = attempts.get(ip) || { count: 0, reset: now + 15 * 60_000 };
    if (attempt.count >= 10) return res.status(429).json({ error: 'ลองใหม่อีกครั้งใน 15 นาที' });
    attempt.count++; attempts.set(ip, attempt);
    const username = String(req.body?.username || '').slice(0, 100);
    const password = String(req.body?.password || '').slice(0, 1024);
    const row = await pool.query('SELECT * FROM admin_accounts WHERE username=$1', [username]);
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = await verifyPassword(password, row.rows[0]?.password_hash || dummy);
    if (!row.rowCount || !valid) {
      await audit(pool, 'anonymous', 'login.failed');
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
    await pool.query("INSERT INTO admin_sessions(token_hash,username,expires_at) VALUES($1,$2,NOW() + INTERVAL '8 hours')", [digest(token), username]);
    await audit(pool, username, 'login.success');
    writeCookie(res, token, 8 * 3600);
    res.json({ username });
  });
  app.use('/api/admin', async (req: Request, res: Response, next: NextFunction) => {
    if (!cookie(req)) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const row = await pool.query('SELECT username FROM admin_sessions WHERE token_hash=$1 AND expires_at > NOW()', [sessions(req)]);
    if (!row.rowCount) return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    res.locals.username = row.rows[0].username;
    next();
  });
  app.get('/api/admin/me', (_req, res) => res.json({ username: res.locals.username }));
  app.post('/api/admin/logout', async (req, res) => {
    await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [sessions(req)]);
    await audit(pool, res.locals.username, 'logout');
    writeCookie(res, '', 0); res.json({ ok: true });
  });
  app.post('/api/admin/password', async (req, res) => {
    const password = String(req.body?.password || '');
    if (password.length < 12 || password.length > 1024) return res.status(400).json({ error: 'รหัสผ่านต้องมี 12–1024 ตัวอักษร' });
    const row = await pool.query('SELECT password_hash FROM admin_accounts WHERE username=$1', [res.locals.username]);
    if (!(await verifyPassword(String(req.body?.currentPassword || '').slice(0, 1024), row.rows[0].password_hash))) return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE admin_accounts SET password_hash=$1 WHERE username=$2', [await hashPassword(password), res.locals.username]);
      await client.query('DELETE FROM admin_sessions WHERE username=$1', [res.locals.username]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await audit(pool, res.locals.username, 'password.changed');
    writeCookie(res, '', 0); res.json({ ok: true });
  });
  app.get('/api/admin/overview', async (_req, res) => {
    const workspaces = await pool.query(`SELECT w.*, (SELECT COUNT(*)::int FROM y_documents d WHERE d.doc_name LIKE 'workspace:' || w.id::text || ':%') AS documents FROM workspaces w ORDER BY created_at DESC`);
    const stats = await pool.query('SELECT COUNT(*)::int AS documents, COALESCE(SUM(octet_length(state)),0)::float AS bytes FROM y_documents');
    const events = await pool.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 8');
    res.json({ workspaces: workspaces.rows, stats: stats.rows[0], connections: options.connections(), events: events.rows, uptime: process.uptime(), version: '0.5.0' });
  });
  app.get('/api/admin/history', async (req, res) => {
    const search = String(req.query.search || '').slice(0, 200);
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const values = [`%${search}%`];
    const where = `WHERE (actor ILIKE $1 OR action ILIKE $1 OR detail ILIKE $1 OR workspace_id ILIKE $1)`;
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_events ${where}`, values);
    const rows = await pool.query(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT 50 OFFSET $2`, [...values, (page - 1) * 50]);
    res.json({ events: rows.rows, total: count.rows[0].total, page });
  });
  app.post('/api/admin/workspaces', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'กรอกชื่อ Workspace ไม่เกิน 120 ตัวอักษร' });
    const workspace: any = await options.createWorkspace(name);
    await audit(pool, res.locals.username, 'workspace.created', workspace.id, name);
    res.status(201).json(workspace);
  });
  app.use('/api/admin/workspaces/:id', async (req, res, next) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid workspace ID' });
    const row = await pool.query('SELECT * FROM workspaces WHERE id=$1', [id]);
    if (!row.rowCount) return res.status(404).json({ error: 'ไม่พบ Workspace' });
    res.locals.workspace = row.rows[0]; next();
  });
  if (options.versionControl) app.use('/api/admin/workspaces/:id/version-control', options.versionControl.router(res => String(res.locals.username)));
  app.patch('/api/admin/workspaces/:id', async (req, res) => {
    const current = res.locals.workspace;
    const name = req.body?.name === undefined ? current.name : String(req.body.name).trim();
    const suspended = req.body?.suspended === undefined ? current.suspended : req.body.suspended;
    if (!name || name.length > 120 || typeof suspended !== 'boolean') return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    await pool.query('UPDATE workspaces SET name=$1,suspended=$2 WHERE id=$3', [name, suspended, current.id]);
    if (suspended) options.disconnect(current.id);
    await audit(pool, res.locals.username, 'workspace.updated', current.id, JSON.stringify({ name, suspended }));
    res.json({ ok: true });
  });
  app.post('/api/admin/workspaces/:id/rotate-invite', async (_req, res) => {
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    await pool.query('UPDATE workspaces SET invite_code=$1 WHERE id=$2', [code, res.locals.workspace.id]);
    await audit(pool, res.locals.username, 'invite.rotated', res.locals.workspace.id);
    res.json({ inviteCode: code });
  });
  app.post('/api/admin/workspaces/:id/revoke', async (_req, res) => {
    const id = res.locals.workspace.id;
    await pool.query('UPDATE workspaces SET token_version=token_version+1, invite_code=$1 WHERE id=$2', [crypto.randomBytes(8).toString('hex').toUpperCase(), id]);
    options.disconnect(id);
    await audit(pool, res.locals.username, 'access.revoked', id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/workspaces/:id', async (req, res) => {
    const w = res.locals.workspace;
    if (req.body?.confirmation !== w.name) return res.status(400).json({ error: 'พิมพ์ชื่อ Workspace เพื่อยืนยัน' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM workspaces WHERE id=$1', [w.id]);
      await client.query('DELETE FROM y_documents WHERE doc_name LIKE $1', [`workspace:${w.id}:%`]);
      await client.query('INSERT INTO audit_events(actor,action,workspace_id,detail) VALUES($1,$2,$3,$4)', [res.locals.username, 'workspace.deleted', w.id, w.name]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    options.disconnect(w.id); res.json({ ok: true });
  });
  app.get('/api/admin/workspaces/:id/files', async (_req, res) => {
    const doc = await options.getDocument(`workspace:${res.locals.workspace.id}:meta`);
    const files = [...doc.getMap<any>('files').values()].map(f => ({ id: f.id, path: f.path, kind: f.kind, size: f.size, updatedAt: f.updatedAt }));
    res.json({ files });
  });
  app.delete('/api/admin/workspaces/:id/files/:fileId', async (req, res) => {
    const name = `workspace:${res.locals.workspace.id}:meta`;
    const doc = await options.getDocument(name);
    const files = doc.getMap<any>('files');
    const file = files.get(String(req.params.fileId));
    if (!file) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    if (req.body?.confirmation !== file.path) return res.status(400).json({ error: 'พิมพ์ path ของไฟล์เพื่อยืนยัน' });
    doc.transact(() => {
      for (const [key, value] of files) if (value.id === file.id || (file.kind === 'folder' && value.path.startsWith(file.path + '/'))) files.delete(key);
    }, 'admin');
    await options.persistDocument(name, doc);
    await audit(pool, res.locals.username, 'file.deleted', res.locals.workspace.id, file.path);
    res.json({ ok: true });
  });
  app.patch('/api/admin/workspaces/:id/files/:fileId', async (req, res) => {
    const name = `workspace:${res.locals.workspace.id}:meta`;
    const doc = await options.getDocument(name);
    const files = doc.getMap<any>('files');
    const file = files.get(String(req.params.fileId));
    if (!file) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    const newPath = String(req.body?.path || '').trim();
    if (!newPath || newPath.length > 500 || /[\\\x00-\x1f]/.test(newPath) || newPath.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return res.status(400).json({ error: 'ใช้ path แบบ relative โดยไม่มีโฟลเดอร์ซ่อน หรือ . และ ..' });
    if (file.kind === 'markdown' && !newPath.endsWith('.md')) return res.status(400).json({ error: 'ไฟล์ Markdown ต้องมีนามสกุล .md' });
    if (file.kind === 'folder' && newPath.startsWith(file.path + '/')) return res.status(400).json({ error: 'ย้ายโฟลเดอร์เข้าไปในตัวเองไม่ได้' });
    const updates = [...files.entries()].filter(([, f]) => f.id === file.id || (file.kind === 'folder' && f.path.startsWith(file.path + '/'))).map(([id, f]) => [id, {...f, path: newPath + f.path.slice(file.path.length), updatedAt: Date.now()}] as const);
    const changed = new Set(updates.map(([id]) => id));
    for (const [, value] of updates) {
      if ([...files.entries()].some(([id, f]) => !changed.has(id) && (f.path === value.path || (f.kind !== 'folder' && value.path.startsWith(f.path + '/'))))) return res.status(409).json({ error: 'มีไฟล์หรือโฟลเดอร์ที่ path ปลายทางแล้ว' });
    }
    doc.transact(() => updates.forEach(([id, value]) => files.set(id, value)), 'admin');
    await options.persistDocument(name, doc);
    await audit(pool, res.locals.username, 'file.renamed', res.locals.workspace.id, `${file.path} → ${newPath}`);
    res.json({ ok: true });
  });
  app.get('/api/admin/workspaces/:id/files/:fileId/download', async (req, res) => {
    const meta = await options.getDocument(`workspace:${res.locals.workspace.id}:meta`);
    const file = [...meta.getMap<any>('files').values()].find(f => f.id === req.params.fileId);
    if (!file || file.kind === 'folder') return res.status(404).json({ error: 'ไม่พบไฟล์' });
    await audit(pool, res.locals.username, 'file.downloaded', res.locals.workspace.id, file.path);
    res.attachment(pathBasename(file.path));
    if (file.kind === 'markdown') {
      const doc = await options.getDocument(`workspace:${res.locals.workspace.id}:doc:${file.id}`);
      res.type('application/octet-stream').send(doc.getText('content').toString());
    } else if (/^[a-f0-9]{64}$/.test(file.hash || '')) await options.downloadBlob(file.hash, res);
    else res.status(404).json({ error: 'ไม่พบข้อมูลไฟล์' });
  });
}
function pathBasename(value: string) { return value.split(/[\\/]/).pop() || 'download'; }

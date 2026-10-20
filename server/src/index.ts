import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { docs, getYDoc, setPersistence, setupWSConnection } from '@y/websocket-server/utils';
import { audit, migrateAdmin, registerAdmin } from './admin.js';
import { VersionControl } from './versions.js';

const PORT = Number(process.env.PORT ?? 3001);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ninesync:ninesync@localhost:5432/ninesync';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
const SERVER_SECRET = process.env.NINESYNC_SERVER_SECRET ?? process.env.NAYSYNC_SERVER_SECRET ?? 'dev-only-change-me';
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const pool = new Pool({ connectionString: DATABASE_URL });

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const workspaceToken = (workspaceId: string, version = 0) => crypto.createHmac('sha256', SERVER_SECRET).update(version ? `${workspaceId}:${version}` : workspaceId).digest('base64url');
const randomInvite = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

async function migrate() {
  await fs.mkdir(BLOB_DIR, { recursive: true });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS y_documents (
      doc_name TEXT PRIMARY KEY,
      state BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await migrateAdmin(pool);
  await versions.migrate();
}

async function validWorkspaceToken(workspaceId: string, token: string | null | undefined) {
  if (!/^[a-f0-9-]{36}$/i.test(workspaceId) || !token) return false;
  const result = await pool.query('SELECT suspended, token_version FROM workspaces WHERE id = $1', [workspaceId]);
  if (result.rowCount !== 1 || result.rows[0].suspended) return false;
  const expected = Buffer.from(workspaceToken(workspaceId, result.rows[0].token_version));
  const actual = Buffer.from(token);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const persistTimers = new Map<string, NodeJS.Timeout>();
const loadingDocs = new Map<string, Promise<void>>();
const activePersists = new Set<Promise<void>>();
const PERSISTENCE_ORIGIN = Symbol('database-hydration');
async function getDocument(name: string) {
  const doc = getYDoc(name);
  await loadingDocs.get(name);
  return doc;
}
async function downloadBlob(hash: string, res: Response) {
  try { res.type('application/octet-stream').send(await fs.readFile(path.join(BLOB_DIR, hash))); }
  catch (error: any) { if (error.code === 'ENOENT') res.status(404).json({ error: 'ไม่พบไฟล์' }); else throw error; }
}
const versions = new VersionControl({
  pool, getDocument, peekDocument: name => docs.get(name), persistDocument: persistDoc, downloadBlob,
  blobExists: async hash => { if (!/^[a-f0-9]{64}$/.test(hash)) return false;try { await fs.access(path.join(BLOB_DIR,hash));return true; } catch { return false; } },
});
function persistDoc(docName: string, ydoc: Y.Doc): Promise<void> {
  const task = writeDoc(docName, ydoc);
  activePersists.add(task);
  void task.finally(() => activePersists.delete(task)).catch(() => {});
  return task;
}
async function writeDoc(docName: string, ydoc: Y.Doc) {
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  await pool.query(
    `INSERT INTO y_documents(doc_name, state, updated_at)
     SELECT $1, $2, NOW() WHERE EXISTS (SELECT 1 FROM workspaces WHERE id::text=$3 FOR KEY SHARE)
     ON CONFLICT (doc_name)
     DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [docName, state, docName.split(':')[1]],
  );
  await pool.query(`INSERT INTO audit_events(actor,action,workspace_id,detail) SELECT 'sync','document.saved',$1,$2 WHERE EXISTS (SELECT 1 FROM workspaces WHERE id::text=$1)`, [docName.split(':')[1], docName]);
}

setPersistence({
  bindState: async (docName, ydoc) => {
    versions.observe(docName, ydoc, PERSISTENCE_ORIGIN);
    ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === PERSISTENCE_ORIGIN) return;
      const previous = persistTimers.get(docName);
      if (previous) clearTimeout(previous);
      persistTimers.set(docName, setTimeout(() => {
        void persistDoc(docName, ydoc).catch(console.error);
        persistTimers.delete(docName);
      }, 750));
    });
    const loading = (async () => {
      const result = await pool.query('SELECT state FROM y_documents WHERE doc_name = $1', [docName]);
      if (result.rowCount === 1 && result.rows[0].state) Y.applyUpdate(ydoc, new Uint8Array(result.rows[0].state), PERSISTENCE_ORIGIN);
    })();
    loadingDocs.set(docName, loading);
    try { await loading; } finally { loadingDocs.delete(docName); }
  },
  writeState: async (docName, ydoc) => {
    const timer = persistTimers.get(docName);
    if (timer) clearTimeout(timer);
    persistTimers.delete(docName);
    await persistDoc(docName, ydoc);
  },
});

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use((req, res, next) => req.path.startsWith('/api/admin') ? next() : cors()(req, res, next));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: '9sync', version: '0.5.0' }));
app.use('/api', express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.redirect('/admin/'));
app.use('/admin', express.static(fileURLToPath(new URL('../public', import.meta.url))));

async function createWorkspace(name: string) {
  const id = crypto.randomUUID();
  const inviteCode = crypto.randomBytes(8).toString('hex').toUpperCase();
  await pool.query('INSERT INTO workspaces(id,name,invite_code) VALUES($1,$2,$3)', [id,name,inviteCode]);
  return { id, name, inviteCode };
}
const connections = new Map<WebSocket, { workspaceId: string; room: string }>();
registerAdmin(app, {
  pool, createWorkspace, versionControl: versions,
  connections: () => [...connections.values()],
  disconnect: (id) => {
    for (const [ws, info] of connections) if (info.workspaceId === id) ws.terminate();
  },
  getDocument,
  persistDocument: persistDoc,
  downloadBlob,
});

app.post('/api/workspaces', async (req, res) => {
  const name = String(req.body?.name ?? '9sync Workspace').trim().slice(0, 120) || '9sync Workspace';
  const id = crypto.randomUUID();
  const token = workspaceToken(id);
  let inviteCode = randomInvite();
  for (let i = 0; i < 4; i += 1) {
    try {
      await pool.query(
        'INSERT INTO workspaces(id, name, invite_code) VALUES($1, $2, $3)',
        [id, name, inviteCode],
      );
      await audit(pool, 'plugin', 'workspace.created', id, name);
      return res.status(201).json({ id, name, token, inviteCode });
    } catch (error: any) {
      if (error?.code === '23505') inviteCode = randomInvite();
      else throw error;
    }
  }
  return res.status(500).json({ error: 'Could not allocate invite code' });
});

app.post('/api/join', async (req, res) => {
  const inviteCode = String(req.body?.inviteCode ?? '').trim().toUpperCase();
  const row = await pool.query('SELECT id, name, token_version FROM workspaces WHERE invite_code = $1 AND suspended=FALSE', [inviteCode]);
  if (row.rowCount !== 1) return res.status(404).json({ error: 'Invite code not found' });
  const token = workspaceToken(row.rows[0].id, row.rows[0].token_version);
  await audit(pool, 'plugin', 'workspace.joined', row.rows[0].id);
  return res.json({ id: row.rows[0].id, name: row.rows[0].name, token });
});

async function auth(req: Request, res: Response, next: NextFunction) {
  const workspaceId = routeParam(req.params.id);
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!(await validWorkspaceToken(workspaceId, token))) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use('/api/workspaces/:id/version-control', auth, versions.router(() => 'workspace-client'));

app.put(
  '/api/workspaces/:id/blobs/:hash',
  auth,
  express.raw({ type: 'application/octet-stream', limit: '512mb' }),
  async (req, res) => {
    const expectedHash = routeParam(req.params.hash).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return res.status(400).json({ error: 'Invalid SHA-256' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
    if (sha256(body) !== expectedHash) return res.status(400).json({ error: 'Hash mismatch' });
    const filePath = path.join(BLOB_DIR, expectedHash);
    try {
      await fs.access(filePath);
      return res.status(204).end();
    } catch {
      await fs.writeFile(filePath, body, { flag: 'wx' }).catch(async (error: any) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      await audit(pool, 'plugin', 'blob.uploaded', routeParam(req.params.id), expectedHash);
      return res.status(201).end();
    }
  },
);

app.get('/api/workspaces/:id/blobs/:hash', auth, async (req, res) => {
  const hash = routeParam(req.params.hash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ error: 'Invalid SHA-256' });
  const filePath = path.join(BLOB_DIR, hash);
  try {
    const data = await fs.readFile(filePath);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    return res.send(data);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: 'Blob not found' });
    throw error;
  }
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

type AuthedRequest = http.IncomingMessage & { nineSyncRoom?: string; nineWorkspaceId?: string };
wss.on('connection', (ws: WebSocket, req: AuthedRequest) => {
  connections.set(ws, { workspaceId: req.nineWorkspaceId!, room: req.nineSyncRoom! });
  ws.on('close', () => connections.delete(ws));
  setupWSConnection(ws as any, req as any, { docName: req.nineSyncRoom ?? 'invalid', gc: true });
});

server.on('upgrade', async (req: AuthedRequest, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    const room = decodeURIComponent(url.pathname.slice('/ws/'.length));
    const workspaceId = url.searchParams.get('workspace') ?? '';
    const token = url.searchParams.get('token');
    if (!room.startsWith(`workspace:${workspaceId}:`) || !(await validWorkspaceToken(workspaceId, token))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    req.nineSyncRoom = room;
    req.nineWorkspaceId = workspaceId;
    // Remove sensitive query params before the Yjs server sees/logs the request.
    req.url = `/ws/${encodeURIComponent(room)}`;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch (error) {
    console.error(error);
    socket.destroy();
  }
});

await migrate();
await versions.baseline();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`9sync server listening on http://0.0.0.0:${PORT}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const documentsToSave = new Map(docs);
    const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
    const socketsClosed = new Promise<void>(resolve => wss.close(() => resolve()));
    for (const client of wss.clients) client.terminate();
    await Promise.all([httpClosed, socketsClosed]);
    await Promise.all([...loadingDocs.values()]);
    for (const entry of docs) documentsToSave.set(...entry);
    for (const timer of persistTimers.values()) clearTimeout(timer);
    persistTimers.clear();
    await versions.flushAll();
    await Promise.all([...documentsToSave].map(([name, doc]) => persistDoc(name, doc)));
    await Promise.all([...activePersists]);
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('9sync shutdown failed; check database connectivity before backup:', error);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import * as Y from 'yjs';
import { lineDiff } from './line-diff.js';

type FileRecord = { id: string; path: string; kind: 'markdown' | 'attachment' | 'folder'; hash?: string; size?: number; updatedAt?: number };
type Snapshot = { file: FileRecord; content: string | null; deleted: boolean; fingerprint: string };
type Options = {
  pool: Pool;
  getDocument: (name: string) => Promise<Y.Doc>;
  peekDocument: (name: string) => Y.Doc | undefined;
  persistDocument: (name: string, doc: Y.Doc) => Promise<void>;
  blobExists: (hash: string) => Promise<boolean>;
  downloadBlob: (hash: string, res: Response) => Promise<void>;
};
const fingerprint = (file: FileRecord, content: string | null, deleted: boolean) => crypto.createHash('sha256').update(JSON.stringify([file.id, file.path, file.kind, content, file.hash || null, file.size ?? null, deleted])).digest('hex');
const metadataName = (id: string) => `workspace:${id}:meta`;
const noteName = (id: string, fileId: string) => `workspace:${id}:doc:${fileId}`;
const safePath = (value: string) => value.length <= 500 && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(p => p && !p.startsWith('.') && !p.includes(':'));
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export class VersionControl {
  private queues = new Map<string, Promise<unknown>>();
  private pending = new Map<string, { workspaceId: string; fileId: string; content: string; quiet: NodeJS.Timeout; maximum: NodeJS.Timeout }>();
  private restoring = new Set<string>();
  constructor(private options: Options) {}

  async migrate() {
    await this.options.pool.query(`CREATE TABLE IF NOT EXISTS file_versions (
      id BIGSERIAL PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT, blob_hash TEXT, size BIGINT, deleted BOOLEAN NOT NULL DEFAULT FALSE,
      fingerprint TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS file_versions_lookup ON file_versions(workspace_id,file_id,id DESC);`);
  }

  private run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  private report(task: Promise<unknown>) { void task.catch(error => console.error('[9sync] version capture failed', error)); }
  async idle() { await Promise.all([...this.queues.values()]); }
  async flushAll() {
    for (const key of [...this.pending.keys()]) await this.flushPending(key);
    await this.idle();
  }
  private async flushWorkspace(id: string) {
    for (const [key, pending] of [...this.pending]) if (pending.workspaceId === id) await this.flushPending(key);
    await this.queues.get(id);
  }

  private async snapshot(id: string, file: FileRecord, deleted = false, content?: string): Promise<Snapshot> {
    const text = file.kind === 'markdown' ? content ?? (await this.options.getDocument(noteName(id, file.id))).getText('content').toString() : null;
    return { file: { ...file }, content: text, deleted, fingerprint: fingerprint(file, text, deleted) };
  }
  private async current(id: string, fileId: string): Promise<Snapshot | null> {
    const meta = await this.options.getDocument(metadataName(id));
    const file = meta.getMap<FileRecord>('files').get(fileId);
    if (file) return this.snapshot(id, file);
    const last = await this.options.pool.query('SELECT * FROM file_versions WHERE workspace_id=$1 AND file_id=$2 ORDER BY id DESC LIMIT 1', [id, fileId]);
    if (!last.rowCount) return null;
    const row = last.rows[0];
    return this.snapshot(id, this.record(row), true, row.content ?? undefined);
  }
  private record(row: any): FileRecord { return { id: row.file_id, path: row.path, kind: row.kind, ...(row.blob_hash ? { hash: row.blob_hash } : {}), ...(row.size !== null ? { size: Number(row.size) } : {}) }; }

  private async captureNow(id: string, snapshot: Snapshot, actor = 'sync', reason = 'automatic', message = '', force = false) {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const workspace = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [id]);
      if (!workspace.rowCount) { await client.query('COMMIT'); return null; }
      const last = await client.query('SELECT id,fingerprint FROM file_versions WHERE workspace_id=$1 AND file_id=$2 ORDER BY id DESC LIMIT 1', [id, snapshot.file.id]);
      if (!force && last.rows[0]?.fingerprint === snapshot.fingerprint) { await client.query('COMMIT'); return last.rows[0]; }
      const f = snapshot.file;
      const row = await client.query(`INSERT INTO file_versions(workspace_id,file_id,path,kind,content,blob_hash,size,deleted,fingerprint,actor,reason,message)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [id,f.id,f.path,f.kind,snapshot.content,f.hash || null,f.size ?? null,snapshot.deleted,snapshot.fingerprint,actor,reason,message]);
      await client.query('COMMIT');
      return row.rows[0];
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  // Capture metadata events immediately, including a pre-delete/pre-rename snapshot.
  // Note text is frozen before awaiting SQL so a rapid edit followed by delete is recoverable.
  observe(name: string, doc: Y.Doc, ignoreOrigin?: unknown) {
    const parts = name.split(':');
    const id = parts[1];
    if (parts[2] === 'meta') {
      const files = doc.getMap<FileRecord>('files');
      files.observe(event => {
        if (ignoreOrigin !== undefined && event.transaction.origin === ignoreOrigin) return;
        if (this.restoring.has(id)) return;
        for (const [fileId, change] of event.changes.keys) {
          const old = change.oldValue as FileRecord | undefined;
          const file = files.get(fileId);
          if (old) this.captureRecord(id, old, false, 'before-change');
          if (file) this.captureRecord(id, file, false, old?.path !== file.path ? 'metadata' : 'automatic');
          else if (old) this.captureRecord(id, old, true, 'deleted');
        }
      });
    } else if (parts[2] === 'doc') {
      doc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (ignoreOrigin !== undefined && origin === ignoreOrigin) return;
        if (this.restoring.has(id)) return;
        const fileId = parts.slice(3).join(':');
        const key = noteName(id, fileId);
        const previous = this.pending.get(key);
        if (previous) clearTimeout(previous.quiet);
        const flush = () => this.report(this.flushPending(key));
        this.pending.set(key, { workspaceId:id, fileId, content:doc.getText('content').toString(), quiet:setTimeout(flush, 1000), maximum:previous?.maximum || setTimeout(flush, 10000) });
      });
    }
  }
  private captureRecord(id: string, file: FileRecord, deleted: boolean, reason: string) {
    if (!file || file.kind === 'folder') return;
    const key = noteName(id, file.id);
    const pending = this.pending.get(key);
    const text = pending?.content ?? this.options.peekDocument(key)?.getText('content').toString();
    if (pending) { clearTimeout(pending.quiet); clearTimeout(pending.maximum); this.pending.delete(key); }
    const frozen = { ...file };
    this.report(this.run(id, async () => this.captureNow(id, await this.snapshot(id, frozen, deleted, text), 'sync', reason)));
  }
  private async flushPending(key: string) {
    const value = this.pending.get(key);
    if (!value) return;
    clearTimeout(value.quiet); clearTimeout(value.maximum); this.pending.delete(key);
    await this.run(value.workspaceId, async () => {
      const meta = await this.options.getDocument(metadataName(value.workspaceId));
      const file = meta.getMap<FileRecord>('files').get(value.fileId);
      if (file) await this.captureNow(value.workspaceId, await this.snapshot(value.workspaceId, file, false, value.content));
    });
  }
  async baseline() {
    const rows = await this.options.pool.query("SELECT doc_name,state FROM y_documents WHERE doc_name LIKE 'workspace:%:meta'");
    for (const row of rows.rows) {
      const id = row.doc_name.split(':')[1];
      const meta = new Y.Doc();
      Y.applyUpdate(meta, new Uint8Array(row.state));
      for (const file of meta.getMap<FileRecord>('files').values()) {
        if (file.kind === 'folder') continue;
        await this.run(id, async () => this.captureNow(id, await this.snapshot(id, file), 'server', 'baseline'));
      }
      meta.destroy();
    }
  }

  private async version(id: string, versionId: string) {
    if (!/^\d+$/.test(versionId)) throw new HttpError(400, 'Invalid version ID');
    const row = await this.options.pool.query('SELECT * FROM file_versions WHERE workspace_id=$1 AND id=$2', [id, versionId]);
    if (!row.rowCount) throw new HttpError(404, 'ไม่พบเวอร์ชันนี้');
    return row.rows[0];
  }

  router(actor: (res: Response) => string) {
    const router = Router({ mergeParams:true });
    const workspaceId = (req: any) => String(req.params.id);
    const page = (req: any) => Math.max(1, Math.min(100000, Math.floor(Number(req.query.page) || 1)));
    router.get('/files', async (req, res) => {
      const id = workspaceId(req); await this.flushWorkspace(id);
      const search = `%${String(req.query.search || '').slice(0,200)}%`;
      const result = await this.options.pool.query(`WITH latest AS (SELECT DISTINCT ON(file_id) id,file_id,path,kind,deleted,created_at FROM file_versions WHERE workspace_id=$1 ORDER BY file_id,id DESC)
        SELECT *,COUNT(*) OVER()::int AS total FROM latest WHERE path ILIKE $2 ORDER BY path LIMIT 50 OFFSET $3`, [id,search,(page(req)-1)*50]);
      res.json({ files:result.rows,total:result.rows[0]?.total || 0,page:page(req) });
    });
    router.get('/files/:fileId/versions', async (req, res) => {
      const id = workspaceId(req); const fileId = String(req.params.fileId);
      await this.flushWorkspace(id);
      const result = await this.options.pool.query(`SELECT id,file_id,path,kind,deleted,actor,reason,message,created_at,octet_length(content)::int AS text_bytes,size,COUNT(*) OVER()::int AS total
        FROM file_versions WHERE workspace_id=$1 AND file_id=$2 ORDER BY id DESC LIMIT 50 OFFSET $3`, [id,fileId,(page(req)-1)*50]);
      res.json({ versions:result.rows,total:result.rows[0]?.total || 0,page:page(req) });
    });
    router.get('/versions/:versionId', async (req, res) => {
      const id = workspaceId(req); await this.flushWorkspace(id);
      const version = await this.version(id,String(req.params.versionId));
      const current = await this.current(id,version.file_id);
      const comparison = req.query.compareTo ? await this.version(id,String(req.query.compareTo)) : null;
      if (comparison && comparison.file_id !== version.file_id) throw new HttpError(400,'เลือกเวอร์ชันของไฟล์เดียวกันเพื่อเปรียบเทียบ');
      const otherContent = comparison ? comparison.content : current?.deleted ? '' : current?.content;
      res.json({ version, current: current && { path:current.file.path,content:current.content,deleted:current.deleted, fingerprint:current.fingerprint }, comparisonId:comparison?.id || 'current', diff:version.kind === 'markdown' ? lineDiff(version.content || '',otherContent || '') : null });
    });
    router.get('/versions/:versionId/download', async (req, res) => {
      const version = await this.version(workspaceId(req),String(req.params.versionId));
      res.attachment(version.path.split('/').pop() || 'download');
      if (version.kind === 'markdown') res.type('application/octet-stream').send(version.content || '');
      else if (/^[a-f0-9]{64}$/.test(version.blob_hash || '')) await this.options.downloadBlob(version.blob_hash,res);
      else throw new HttpError(404, 'ไม่พบไฟล์แนบของเวอร์ชันนี้');
    });
    router.post('/files/:fileId/checkpoint', async (req, res) => {
      const id = workspaceId(req); await this.flushWorkspace(id);
      const result = await this.run(id, async () => {
        const snapshot = await this.current(id,String(req.params.fileId));
        if (!snapshot || snapshot.deleted || snapshot.file.kind === 'folder') throw new HttpError(404, 'ไม่พบไฟล์ที่กำลังใช้งาน');
        const message = String(req.body?.message || '').trim().slice(0,200);
        return this.captureNow(id,snapshot,actor(res),'checkpoint',message,true);
      });
      res.status(201).json(result);
    });
    router.post('/versions/:versionId/restore', async (req, res) => {
      const id = workspaceId(req); await this.flushWorkspace(id);
      const result = await this.run(id, async () => {
        const version = await this.version(id,String(req.params.versionId));
        if (!safePath(version.path)) throw new HttpError(400,'Path ของเวอร์ชันนี้ไม่ปลอดภัยสำหรับการกู้คืน');
        const meta = await this.options.getDocument(metadataName(id));
        const files = meta.getMap<FileRecord>('files');
        const note = version.kind === 'markdown' ? await this.options.getDocument(noteName(id,version.file_id)) : null;
        if (version.kind === 'attachment' && !(await this.options.blobExists(version.blob_hash || ''))) throw new HttpError(404,'ไม่พบข้อมูลไฟล์แนบสำหรับกู้คืน');
        const before = await this.current(id,version.file_id);
        if (!before || !req.body?.expectedFingerprint || before.fingerprint !== req.body.expectedFingerprint) throw new HttpError(409,'ไฟล์เปลี่ยนแปลงแล้ว กรุณาเปิดเวอร์ชันใหม่ก่อนกู้คืน');
        await this.captureNow(id,before,actor(res),'before-restore',`Before restoring version ${version.id}`,true);
        // Re-read in-memory state after SQL, with no asynchronous gap before applying.
        const currentFile = files.get(version.file_id);
        const fresh = currentFile ? fingerprint(currentFile,note ? note.getText('content').toString() : null,false) : before.fingerprint;
        if (fresh !== req.body.expectedFingerprint || (!currentFile && !before.deleted)) throw new HttpError(409,'ไฟล์ถูกแก้ไขระหว่างกู้คืน กรุณาโหลดใหม่');
        for (const f of files.values()) {
          if (f.id !== version.file_id && (f.path === version.path || (f.kind !== 'folder' && version.path.startsWith(f.path+'/')) || f.path.startsWith(version.path+'/'))) throw new HttpError(409,'มีไฟล์หรือโฟลเดอร์อื่นใช้ path นี้แล้ว');
        }
        this.restoring.add(id);
        try {
          if (note) note.transact(() => { const text=note.getText('content');text.delete(0,text.length);text.insert(0,version.content || ''); },'version-restore');
          meta.transact(() => {
            const parts = version.path.split('/').slice(0,-1); let parent='';
            for (const part of parts) { parent=parent?`${parent}/${part}`:part; if (![...files.values()].some(f=>f.path===parent)) { const folderId=crypto.randomUUID();files.set(folderId,{id:folderId,path:parent,kind:'folder',updatedAt:Date.now()}); } }
            files.set(version.file_id,{...this.record(version),updatedAt:Date.now()});
          },'version-restore');
          this.restoring.delete(id);
          if (note) await this.options.persistDocument(noteName(id,version.file_id),note);
          await this.options.persistDocument(metadataName(id),meta);
          const restored = await this.current(id,version.file_id);
          const saved = await this.captureNow(id,restored!,actor(res),'restore',`Restored version ${version.id}`,true);
          await this.options.pool.query('INSERT INTO audit_events(actor,action,workspace_id,detail) VALUES($1,$2,$3,$4)',[actor(res),'version.restored',id,`${version.path} ← version ${version.id}`]);
          return { ok:true,id:saved?.id };
        } finally { this.restoring.delete(id); }
      });
      res.json(result);
    });
    router.use((error: any, _req: any, res: Response, next: any) => { if (error instanceof HttpError) res.status(error.status).json({error:error.message});else next(error); });
    return router;
  }
}

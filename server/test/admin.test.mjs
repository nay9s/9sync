import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';
import { audit, migrateAdmin, registerAdmin } from '../dist/admin.js';
import { VersionControl } from '../dist/versions.js';

test('admin authentication, workspace lifecycle, files, audit and session revocation', async () => {
  const db = new PGlite();
  const query = async (sql, values) => {
    if (!values && sql.trim().split(';').filter(s => s.trim()).length > 1) {
      const result = (await db.exec(sql)).at(-1);
      return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
    }
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const password = crypto.randomBytes(20).toString('hex');
  process.env.NINESYNC_ADMIN_USERNAME = 'admin';
  process.env.NINESYNC_ADMIN_PASSWORD = password;
  await db.exec(`CREATE TABLE workspaces(id UUID PRIMARY KEY,name TEXT NOT NULL,invite_code TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE y_documents(doc_name TEXT PRIMARY KEY,state BYTEA NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW());`);
  await migrateAdmin(pool);
  await migrateAdmin(pool); // Existing installations migrate without resetting credentials.
  const documents = new Map();
  let versionControl;
  const getDocument = async name => {
    if (!documents.has(name)) { const doc=new Y.Doc();documents.set(name,doc);versionControl.observe(name,doc); }
    return documents.get(name);
  };
  const persistDocument = async (name, doc) => query('INSERT INTO y_documents(doc_name,state) VALUES($1,$2) ON CONFLICT(doc_name) DO UPDATE SET state=EXCLUDED.state', [name, Buffer.from(Y.encodeStateAsUpdate(doc))]);
  versionControl=new VersionControl({pool,getDocument,peekDocument:name=>documents.get(name),persistDocument,blobExists:async()=>true,downloadBlob:async(_hash,res)=>res.send('blob data')});
  await versionControl.migrate();
  const disconnected = [];
  const app = express();
  app.use(express.json());
  app.use('/admin', express.static(new URL('../public', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')));
  registerAdmin(app, {
    pool, versionControl,
    disconnect: id => disconnected.push(id),
    getDocument, persistDocument,
    createWorkspace: async name => { const id = crypto.randomUUID(); const inviteCode = crypto.randomBytes(8).toString('hex'); await query('INSERT INTO workspaces(id,name,invite_code) VALUES($1,$2,$3)', [id, name, inviteCode]); return { id, name, inviteCode }; },
    connections: () => [],
    downloadBlob: async (_hash, res) => res.send(Buffer.from('blob data')),
  });
  app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  let cookie = '';
  async function request(url, method = 'GET', body, custom = {}) {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-nine-admin': '1', cookie, ...custom }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie'), headers: response.headers };
  }
  try {
    assert.equal((await request('/overview')).status, 401);
    assert.equal((await request('/login', 'POST', {username:'admin', password}, {'x-nine-admin':''})).status, 403);
    assert.equal((await request('/login', 'POST', {username:'admin',password:'wrong'})).status, 401);
    const login = await request('/login','POST',{username:'admin',password});
    assert.equal(login.status,200); assert.match(login.cookie,/HttpOnly/); assert.match(login.cookie,/SameSite=Strict/);
    cookie = login.cookie.split(';')[0];
    assert.equal((await request('/me')).data.username,'admin');
    const overview = await request('/overview'); assert.equal(overview.status,200); assert.equal(overview.data.workspaces.length,0);
    assert.equal((await request('/workspaces','POST',{name:' '})).status,400);
    const created = await request('/workspaces','POST',{name:'Test Vault'});
    assert.equal(created.status,201); const id = created.data.id;
    assert.equal((await request('/workspaces/not-a-uuid','PATCH',{name:'bad'})).status,400);
    assert.equal((await request(`/workspaces/${id}`,'PATCH',{name:'Renamed Vault',suspended:true})).status,200);
    assert.equal(disconnected.at(-1),id);
    let row = (await query('SELECT * FROM workspaces WHERE id=$1',[id])).rows[0]; assert.equal(row.suspended,true);
    assert.equal((await request(`/workspaces/${id}/rotate-invite`,'POST',{})).status,200);
    assert.equal((await request(`/workspaces/${id}/revoke`,'POST',{})).status,200);
    row = (await query('SELECT * FROM workspaces WHERE id=$1',[id])).rows[0]; assert.equal(row.token_version,1);
    const meta = new Y.Doc();
    meta.getMap('files').set('one',{id:'one',path:'Notes/test.md',kind:'markdown',updatedAt:Date.now()});
    meta.getMap('files').set('two',{id:'two',path:'Notes/other.md',kind:'markdown',updatedAt:Date.now()});
    meta.getMap('files').set('folder',{id:'folder',path:'Notes',kind:'folder',updatedAt:Date.now()});
    const note = new Y.Doc(); note.getText('content').insert(0,'ทดสอบ 9sync');
    documents.set(`workspace:${id}:meta`,meta); documents.set(`workspace:${id}:doc:one`,note);
    assert.equal((await request(`/workspaces/${id}/files`)).data.files.length,3);
    const download = await request(`/workspaces/${id}/files/one/download`); assert.equal(download.status,200); assert.equal(download.data,'ทดสอบ 9sync');
    assert.match(download.headers.get('content-disposition'),/attachment/);
    assert.equal((await request(`/workspaces/${id}/files/one`,'PATCH',{path:'../test.md'})).status,400);
    assert.equal((await request(`/workspaces/${id}/files/one`,'PATCH',{path:'Notes/other.md'})).status,409);
    assert.equal((await request(`/workspaces/${id}/files/folder`,'PATCH',{path:'Renamed'})).status,200);
    assert.equal(meta.getMap('files').get('one').path,'Renamed/test.md');
    assert.equal((await request(`/workspaces/${id}/files/one`,'DELETE',{confirmation:'wrong'})).status,400);
    assert.equal((await request(`/workspaces/${id}/files/folder`,'DELETE',{confirmation:'Renamed'})).status,200);
    assert.equal(meta.getMap('files').size,0);
    const history = await request('/history?search=file.'); assert.equal(history.status,200); assert.equal(history.data.total,3);
    for (let i=0;i<51;i++) await audit(pool,'test','pagination');
    assert.equal((await request('/history?search=pagination&page=2')).data.events.length,1);
    assert.equal((await request(`/workspaces/${id}`,'DELETE',{confirmation:'wrong'})).status,400);
    assert.equal((await request(`/workspaces/${id}`,'DELETE',{confirmation:'Renamed Vault'})).status,200);
    assert.equal((await query('SELECT * FROM workspaces')).rows.length,0);
    assert.equal((await query('SELECT * FROM y_documents')).rows.length,0);
    assert.equal((await request('/history?search=workspace.deleted')).data.total,1);
    assert.equal((await request('/password','POST',{currentPassword:'wrong',password:'a new strong password'})).status,400);
    assert.equal((await request('/password','POST',{currentPassword:password,password:'short'})).status,400);
    assert.equal((await request('/password','POST',{currentPassword:password,password:'a new strong password'})).status,200);
    assert.equal((await request('/me')).status,401);
    assert.equal((await request('/login','POST',{username:'admin',password})).status,401);
    const second = await request('/login','POST',{username:'admin',password:'a new strong password'}); assert.equal(second.status,200);
    cookie=second.cookie.split(';')[0]; assert.equal((await request('/logout','POST',{})).status,200); assert.equal((await request('/me')).status,401);
    if (process.env.NINESYNC_TEST_KEEP_OPEN === '1') {
      const previewId=crypto.randomUUID();
      await query('INSERT INTO workspaces(id,name,invite_code) VALUES($1,$2,$3)',[previewId,'Version control · Test Workspace','TEST-ONLY']);
      const meta=await getDocument(`workspace:${previewId}:meta`),note=await getDocument(`workspace:${previewId}:doc:preview-note`);
      note.getText('content').insert(0,'# แผนการทำงาน\n\n- ออกแบบระบบ\n- พัฒนา plugin\n');
      meta.getMap('files').set('preview-note',{id:'preview-note',path:'Notes/Project.md',kind:'markdown'});
      await versionControl.flushAll();
      note.getText('content').insert(note.getText('content').length,'- เพิ่ม Version control\n');
      await versionControl.flushAll();
      console.log(`TEST UI ONLY: http://127.0.0.1:${server.address().port}/admin/`);
      console.log('Test account: admin / a new strong password');
      await new Promise(() => {});
    }
  } finally { await versionControl.flushAll();await new Promise(resolve => server.close(resolve)); await db.close(); for (const doc of documents.values()) doc.destroy(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';
import { VersionControl } from '../dist/versions.js';
import { lineDiff } from '../dist/line-diff.js';

test('line diff handles insert, delete, empty, Thai, newline changes and bounded large inputs', () => {
  let d=lineDiff('หนึ่ง\nสอง\nสาม\n','หนึ่ง\nใหม่\nสาม\n');
  assert.equal(d.added,1);assert.equal(d.removed,1);assert.equal(d.lines.find(l=>l.type==='removed').text,'สอง\n');
  assert.equal(lineDiff('','').added,0);
  assert.equal(lineDiff('x','x\n').removed,1);
  assert.equal(lineDiff('a\n','').removed,1);
  assert.equal(lineDiff('same\n','same\n').added,0);
  d=lineDiff(Array.from({length:3000},(_,i)=>`a${i}\n`).join(''),Array.from({length:3000},(_,i)=>`b${i}\n`).join(''));
  assert.equal(d.simplified,true);assert.equal(d.truncated,true);assert.ok(d.lines.length<=2001);
});

test('durable version history: automatic captures, rename/delete, checkpoint, diff, restore and conflict protection', async () => {
  const db=new PGlite();
  const query=async(sql,args)=>{
    const r=!args && sql.trim().split(';').filter(s=>s.trim()).length>1?(await db.exec(sql)).at(-1):await db.query(sql,args);
    return {...r,rowCount:r.rows.length||r.affectedRows||0};
  };
  const pool={query,connect:async()=>({query,release(){}})};
  await db.exec(`CREATE TABLE workspaces(id UUID PRIMARY KEY);CREATE TABLE y_documents(doc_name TEXT PRIMARY KEY,state BYTEA NOT NULL);CREATE TABLE audit_events(actor TEXT,action TEXT,workspace_id TEXT,detail TEXT);`);
  const id=crypto.randomUUID(),other=crypto.randomUUID();
  await query('INSERT INTO workspaces(id) VALUES($1),($2)',[id,other]);
  const documents=new Map();let versions;
  const persist=async(name,doc)=>query('INSERT INTO y_documents(doc_name,state) VALUES($1,$2) ON CONFLICT(doc_name) DO UPDATE SET state=EXCLUDED.state',[name,Buffer.from(Y.encodeStateAsUpdate(doc))]);
  const getDocument=async name=>{
    if(documents.has(name))return documents.get(name);
    const doc=new Y.Doc();const row=await query('SELECT state FROM y_documents WHERE doc_name=$1',[name]);if(row.rowCount)Y.applyUpdate(doc,new Uint8Array(row.rows[0].state));
    documents.set(name,doc);versions.observe(name,doc);return doc;
  };
  versions=new VersionControl({pool,getDocument,peekDocument:name=>documents.get(name),persistDocument:persist,blobExists:async hash=>hash==='a'.repeat(64),downloadBlob:async(_hash,res)=>res.send('original binary')});
  await versions.migrate();await versions.migrate();
  const app=express();app.use(express.json());
  app.use('/api/workspaces/:id/version-control',(req,res,next)=>req.header('authorization')==='Bearer test-token'?next():res.status(401).json({error:'Unauthorized'}),versions.router(()=> 'test-client'));
  app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.message});});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/workspaces/`;
  const request=async(path,method='GET',body,workspace=id,token='test-token')=>{
    const res=await fetch(`${base}${workspace}/version-control${path}`,{method,headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:res.status,data};
  };
  try{
    assert.equal((await request('/files','GET',undefined,id,'bad')).status,401);
    const meta=await getDocument(`workspace:${id}:meta`),note=await getDocument(`workspace:${id}:doc:note`);
    note.getText('content').insert(0,'first\nทดสอบ\n');
    meta.getMap('files').set('note',{id:'note',path:'Notes/Test.md',kind:'markdown',updatedAt:1});
    await versions.flushAll();
    let history=await request('/files/note/versions');assert.equal(history.status,200);assert.equal(history.data.total,1);
    const first=history.data.versions[0].id;
    note.transact(()=>{note.getText('content').delete(0,note.getText('content').length);note.getText('content').insert(0,'second\nทดสอบ\n');});
    await versions.flushAll();
    history=await request('/files/note/versions');assert.equal(history.data.total,2);
    const second=history.data.versions[0].id;
    const detail=await request(`/versions/${first}`);assert.equal(detail.data.version.content,'first\nทดสอบ\n');assert.equal(detail.data.current.content,'second\nทดสอบ\n');assert.equal(detail.data.diff.added,1);
    assert.equal((await request(`/versions/${first}?compareTo=${second}`)).data.comparisonId,second);
    assert.equal((await request(`/versions/${first}`,'GET',undefined,other)).status,404);
    assert.equal((await request('/versions/not-an-id')).status,400);
    assert.equal((await request('/files/note/checkpoint','POST',{message:'Before release'})).status,201);
    history=await request('/files/note/versions');assert.equal(history.data.versions[0].message,'Before release');
    // Several rapid edits followed by delete must retain the final unsaved content.
    note.getText('content').insert(note.getText('content').length,'last unsaved edit');
    meta.getMap('files').set('note',{...meta.getMap('files').get('note'),path:'Archive/Renamed.md',updatedAt:2});
    meta.getMap('files').delete('note');
    await versions.flushAll();
    let listing=await request('/files');assert.equal(listing.data.files.length,1);assert.equal(listing.data.files[0].deleted,true);
    history=await request('/files/note/versions');
    assert.equal(history.data.versions[0].reason,'deleted');
    const deleted=await request(`/versions/${history.data.versions[0].id}`);assert.match(deleted.data.version.content,/last unsaved edit/);
    let target=await request(`/versions/${first}`);
    assert.equal((await request(`/versions/${first}/restore`,'POST',{})).status,409);
    assert.equal((await request(`/versions/${first}/restore`,'POST',{expectedFingerprint:target.data.current.fingerprint})).status,200);
    assert.equal(meta.getMap('files').get('note').path,'Notes/Test.md');assert.equal(note.getText('content').toString(),'first\nทดสอบ\n');
    assert.ok([...meta.getMap('files').values()].some(f=>f.kind==='folder'&&f.path==='Notes'));
    history=await request('/files/note/versions');assert.equal(history.data.versions[0].reason,'restore');assert.ok(history.data.versions.some(v=>v.reason==='before-restore'));
    // Compare-and-swap: a collaborator edit after preview prevents overwriting their changes.
    target=await request(`/versions/${second}`);note.getText('content').insert(0,'collaborator ');
    assert.equal((await request(`/versions/${second}/restore`,'POST',{expectedFingerprint:target.data.current.fingerprint})).status,409);
    assert.match(note.getText('content').toString(),/^collaborator/);
    // Occupied historical path is never overwritten.
    meta.getMap('files').set('note',{...meta.getMap('files').get('note'),path:'Elsewhere/Test.md'});
    meta.getMap('files').set('collision',{id:'collision',path:'Notes/Test.md',kind:'attachment',hash:'a'.repeat(64),size:15});
    target=await request(`/versions/${first}`);
    assert.equal((await request(`/versions/${first}/restore`,'POST',{expectedFingerprint:target.data.current.fingerprint})).status,409);
    // Binary versions retain their blob reference and restore the previous bytes via metadata.
    let binary=(await request('/files/collision/versions')).data.versions[0];assert.ok(binary);
    meta.getMap('files').set('collision',{id:'collision',path:'Notes/Test.md',kind:'attachment',hash:'b'.repeat(64),size:99});
    target=await request(`/versions/${binary.id}`);assert.equal((await request(`/versions/${binary.id}/download`)).data,'original binary');
    assert.equal((await request(`/versions/${binary.id}/restore`,'POST',{expectedFingerprint:target.data.current.fingerprint})).status,200);
    assert.equal(meta.getMap('files').get('collision').hash,'a'.repeat(64));
    // History survives replacing Y.Doc objects (equivalent to restart/reload).
    await persist(`workspace:${id}:meta`,meta);await persist(`workspace:${id}:doc:note`,note);await versions.flushAll();
    for(const doc of documents.values())doc.destroy();documents.clear();
    const reloaded=await request(`/versions/${first}`);assert.equal(reloaded.data.version.content,'first\nทดสอบ\n');assert.match(reloaded.data.current.content,/collaborator/);
    await versions.baseline();await versions.flushAll();
    assert.ok((await request('/files?search=Elsewhere')).data.total>=1);
    await query('DELETE FROM workspaces WHERE id=$1',[id]);assert.equal((await query('SELECT * FROM file_versions WHERE workspace_id=$1',[id])).rowCount,0);
  }finally{await versions.flushAll();await new Promise(resolve=>server.close(resolve));for(const doc of documents.values())doc.destroy();await db.close();}
});

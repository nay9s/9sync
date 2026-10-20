import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { docs, getYDoc, setPersistence, setupWSConnection } from '@y/websocket-server/utils';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';
import { VersionControl } from '../dist/versions.js';

test('restoring a revision propagates over real Yjs WebSockets to two connected clients',async()=>{
  const db=new PGlite();
  const query=async(sql,args)=>{const r=!args&&sql.trim().split(';').filter(s=>s.trim()).length>1?(await db.exec(sql)).at(-1):await db.query(sql,args);return{...r,rowCount:r.rows.length||r.affectedRows||0};};
  const pool={query,connect:async()=>({query,release(){}})};
  await db.exec('CREATE TABLE workspaces(id UUID PRIMARY KEY);CREATE TABLE y_documents(doc_name TEXT PRIMARY KEY,state BYTEA NOT NULL);CREATE TABLE audit_events(actor TEXT,action TEXT,workspace_id TEXT,detail TEXT);');
  const id=crypto.randomUUID();await query('INSERT INTO workspaces(id) VALUES($1)',[id]);
  const loading=new Map();
  const getDocument=async name=>{const doc=getYDoc(name);await loading.get(name);return doc;};
  const persist=async(name,doc)=>query('INSERT INTO y_documents(doc_name,state) VALUES($1,$2) ON CONFLICT(doc_name) DO UPDATE SET state=EXCLUDED.state',[name,Buffer.from(Y.encodeStateAsUpdate(doc))]);
  const versions=new VersionControl({pool,getDocument,peekDocument:name=>docs.get(name),persistDocument:persist,blobExists:async()=>false,downloadBlob:async()=>{}});
  await versions.migrate();
  setPersistence({bindState:(name,doc)=>{const done=(async()=>{const row=await query('SELECT state FROM y_documents WHERE doc_name=$1',[name]);if(row.rowCount)Y.applyUpdate(doc,new Uint8Array(row.rows[0].state));versions.observe(name,doc);})();loading.set(name,done);return done;},writeState:persist});
  const app=express();app.use(express.json());app.use('/api/workspaces/:id/version-control',versions.router(()=> 'test'));
  app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.message});});
  const server=http.createServer(app),wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>setupWSConnection(ws,req,{docName:decodeURIComponent(req.url.slice(1))})));
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const port=server.address().port,room=`workspace:${id}:doc:live-note`;
  const a=new Y.Doc(),b=new Y.Doc();
  const pa=new WebsocketProvider(`ws://127.0.0.1:${port}`,room,a,{WebSocketPolyfill:WebSocket,disableBc:true});
  const pb=new WebsocketProvider(`ws://127.0.0.1:${port}`,room,b,{WebSocketPolyfill:WebSocket,disableBc:true});
  const waitFor=async check=>{const deadline=Date.now()+8000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out waiting for WebSocket sync');await new Promise(resolve=>setTimeout(resolve,20));}};
  const api=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${port}/api/workspaces/${id}/version-control${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
  try{
    await waitFor(()=>pa.synced&&pb.synced);
    const meta=await getDocument(`workspace:${id}:meta`);meta.getMap('files').set('live-note',{id:'live-note',path:'Live.md',kind:'markdown'});
    a.getText('content').insert(0,'version one');await waitFor(()=>b.getText('content').toString()==='version one');
    await versions.flushAll();let history=await api('/files/live-note/versions');const original=history.data.versions[0].id;
    b.transact(()=>{b.getText('content').delete(0,b.getText('content').length);b.getText('content').insert(0,'version two');});
    await waitFor(()=>a.getText('content').toString()==='version two');
    const detail=await api(`/versions/${original}`);
    const restored=await api(`/versions/${original}/restore`,{expectedFingerprint:detail.data.current.fingerprint});assert.equal(restored.status,200);
    await waitFor(()=>a.getText('content').toString()==='version one'&&b.getText('content').toString()==='version one');
    history=await api('/files/live-note/versions');assert.equal(history.data.versions[0].reason,'restore');
    const before=history.data.versions.find(v=>v.reason==='before-restore');assert.equal((await api(`/versions/${before.id}`)).data.version.content,'version two');
    const durable=await query('SELECT state FROM y_documents WHERE doc_name=$1',[room]);const check=new Y.Doc();Y.applyUpdate(check,new Uint8Array(durable.rows[0].state));assert.equal(check.getText('content').toString(),'version one');check.destroy();
  }finally{
    pa.destroy();pb.destroy();a.destroy();b.destroy();
    for(const socket of wss.clients)socket.terminate();
    await new Promise(resolve=>wss.close(resolve));await versions.flushAll();
    for(const doc of docs.values())doc.destroy();docs.clear();
    await new Promise(resolve=>server.close(resolve));
    await db.close();setPersistence(null);
  }
});

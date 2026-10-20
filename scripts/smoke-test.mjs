// CI-only integration check against a disposable Compose deployment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
if(process.env.CI!=='true')throw new Error('Run this smoke test only in a disposable CI deployment (CI=true).');
const base=process.env.NINESYNC_TEST_URL || 'http://127.0.0.1:3001';
let cookie='',workspace;
const providers=[],documents=[];
async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Nine-Admin':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${result.error || ''}`);return{result,cookie:response.headers.get('set-cookie')};}
async function waitFor(check){const end=Date.now()+12000;while(!(await check())){if(Date.now()>end)throw new Error('Timed out waiting for sync');await new Promise(resolve=>setTimeout(resolve,30));}}
try{
  assert.equal((await api('/api/health')).result.ok,true);
  const login=await api('/api/admin/login','POST',{username:process.env.NINESYNC_ADMIN_USERNAME || 'admin',password:process.env.NINESYNC_ADMIN_PASSWORD});cookie=login.cookie.split(';')[0];
  workspace=(await api('/api/admin/workspaces','POST',{name:`CI disposable ${crypto.randomUUID()}`})).result;
  const joined=(await api('/api/join','POST',{inviteCode:workspace.inviteCode})).result;
  const fileId=crypto.randomUUID();
  function connect(room){const doc=new Y.Doc();documents.push(doc);const provider=new WebsocketProvider(base.replace(/^http/,'ws'),`workspace:${workspace.id}:${room}`,doc,{WebSocketPolyfill:WebSocket,disableBc:true,params:{workspace:workspace.id,token:joined.token}});providers.push(provider);return{doc,provider};}
  const meta=connect('meta'),a=connect(`doc:${fileId}`),b=connect(`doc:${fileId}`);
  await waitFor(()=>providers.every(p=>p.synced));
  meta.doc.getMap('files').set(fileId,{id:fileId,path:'CI-test.md',kind:'markdown',updatedAt:Date.now()});
  a.doc.getText('content').insert(0,'first version');
  await waitFor(()=>b.doc.getText('content').toString()==='first version');
  const admin=`/api/admin/workspaces/${workspace.id}`;
  await waitFor(async()=> (await api(`${admin}/files`)).result.files.some(f=>f.id===fileId));
  const root=`${admin}/version-control`;
  const checkpoint=(await api(`${root}/files/${fileId}/checkpoint`,'POST',{message:'CI baseline'})).result;
  b.doc.transact(()=>{const text=b.doc.getText('content');text.delete(0,text.length);text.insert(0,'second version');});
  await waitFor(()=>a.doc.getText('content').toString()==='second version');
  const detail=(await api(`${root}/versions/${checkpoint.id}`)).result;
  assert.equal(detail.version.content,'first version');assert.equal(detail.current.content,'second version');
  await api(`${root}/versions/${checkpoint.id}/restore`,'POST',{expectedFingerprint:detail.current.fingerprint});
  await waitFor(()=>[a,b].every(client=>client.doc.getText('content').toString()==='first version'));
  const history=(await api(`${root}/files/${fileId}/versions`)).result;
  assert.equal(history.versions[0].reason,'restore');assert.ok(history.versions.some(v=>v.reason==='before-restore'));
  console.log('Compose smoke passed: health, admin auth, PostgreSQL migration, join, two-client Yjs sync and version restore.');
}finally{
  for(const provider of providers)provider.destroy();for(const doc of documents)doc.destroy();
  if(workspace)await api(`/api/admin/workspaces/${workspace.id}`,'DELETE',{confirmation:workspace.name});
}

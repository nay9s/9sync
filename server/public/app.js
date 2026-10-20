const $ = (s) => document.querySelector(s);
const paths = { grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', layers:'m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5', file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5', clock:'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2', logout:'M9 5H4v14h5 M10 12h11 M17 8l4 4-4 4', plus:'M12 5v14 M5 12h14', refresh:'M20 7v5h-5 M4 17v-5h5 M5 7a8 8 0 0 1 13-2l2 3 M4 16l2 3a8 8 0 0 0 13-2', search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', server:'M3 3h18v7H3z M3 14h18v7H3z M7 6h.01 M7 17h.01', link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2', download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7', arrow:'M5 12h14 M14 7l5 5-5 5', shield:'m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z M8 12l3 3 5-6' };
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(e => e.innerHTML = icon(e.dataset.icon));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => value ? new Date(value).toLocaleString('th-TH',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',year:'2-digit'}) : '—';
const bytes = n => n < 1024 ? `${n || 0} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
const titles = { overview:'ภาพรวม',workspaces:'Workspace',files:'ไฟล์ทั้งหมด',versions:'ประวัติเวอร์ชัน',history:'ประวัติกิจกรรม',settings:'ตั้งค่าระบบ' };
const actionNames = {'login.success':'เข้าสู่ระบบสำเร็จ','login.failed':'เข้าสู่ระบบไม่สำเร็จ',logout:'ออกจากระบบ','workspace.created':'สร้าง Workspace','workspace.updated':'อัปเดต Workspace','workspace.deleted':'ลบ Workspace','workspace.joined':'เข้าร่วม Workspace','document.saved':'บันทึกการซิงก์เอกสาร','blob.uploaded':'อัปโหลดไฟล์แนบ','file.downloaded':'ดาวน์โหลดไฟล์','file.deleted':'ลบไฟล์','invite.rotated':'เปลี่ยนรหัสเชิญ','access.revoked':'เพิกถอนสิทธิ์การเชื่อมต่อ','password.changed':'เปลี่ยนรหัสผ่าน'};
actionNames['version.restored']='กู้คืนเวอร์ชันไฟล์';
actionNames['file.renamed'] = 'เปลี่ยนชื่อหรือย้ายไฟล์';
let state = null, account = '', currentPage = '', renderVersion = 0, historyPage = 1, historySearch = '', workspaceSearch = '', selectedWorkspace = '', fileSearch = '', files = [], toastTimer;
async function api(url, options = {}) {
  const response = await fetch('/api/admin' + url, { ...options, headers:{'Content-Type':'application/json','X-Nine-Admin':'1',...options.headers}, credentials:'same-origin' });
  const data = await response.json().catch(() => ({error:'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง'}));
  if (!response.ok) {
    if (response.status === 401 && url !== '/login') showLogin();
    throw new Error(data.error || 'ไม่สามารถดำเนินการได้');
  }
  return data;
}
const send = (url, method, body) => api(url,{method,body:JSON.stringify(body)});
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function showLogin() { $('#console').hidden = true; $('#login').hidden = false; $('#password').value = ''; $('#username').focus(); }
function showConsole() { $('#login').hidden = true; $('#console').hidden = false; $('#account-name').textContent = account; render(); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { const data = await send('/login','POST',{username:$('#username').value,password:$('#password').value}); account = data.username; $('#password').value=''; showConsole(); }
  catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#logout').onclick = async () => { try { await send('/logout','POST',{}); showLogin(); } catch(error) { toast(error.message); } };
window.addEventListener('hashchange', () => { historyPage=1; render(); });
function empty(title, description, kind='layers') { return `<div class="empty">${icon(kind)}<strong>${esc(title)}</strong><p>${esc(description)}</p></div>`; }
function heading(title, sub, action = '') { return `<div class="page-heading"><div><span class="eyebrow">9SYNC / ADMINISTRATION</span><h1>${title}</h1><p>${sub}</p></div><div class="actions"><button class="secondary" data-action="refresh">${icon('refresh')}รีเฟรช</button>${action}</div></div>`; }
function newButton() { return `<button class="primary" data-action="create">${icon('plus')}สร้าง Workspace</button>`; }
function workspaceRows(rows, compact=false) {
  if (!rows.length) return empty('ยังไม่มี Workspace','สร้าง Workspace แรกเพื่อเริ่มต้นเชื่อมต่อ Vault ของคุณ');
  return `<div class="table-scroll"><table><thead><tr><th>ชื่อ WORKSPACE</th><th>สถานะ</th><th>เอกสาร</th>${compact?'':'<th>รหัสเชิญ</th><th>สร้างเมื่อ</th>'}<th>จัดการ</th></tr></thead><tbody>${rows.map(w=>`<tr><td><div class="workspace-cell"><span class="workspace-icon">${icon('layers')}</span><div><b>${esc(w.name)}</b><small>${esc(w.id.slice(0,8))}</small></div></div></td><td><span class="badge ${w.suspended?'paused':''}">${w.suspended?'ระงับแล้ว':'ใช้งานอยู่'}</span></td><td>${w.documents}</td>${compact?'':`<td><button class="text-button mono" data-action="copy" data-value="${esc(w.invite_code)}" title="คัดลอกรหัสเชิญ">${esc(w.invite_code)}</button></td><td class="muted">${date(w.created_at)}</td>`}<td><button class="text-button" data-action="manage" data-id="${w.id}">จัดการ ${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function eventItems(events) {
  return events.length ? `<div class="activity">${events.slice(0,5).map(e=>`<div class="event"><span class="event-icon">${icon(e.action.startsWith('login')?'shield':'clock')}</span><div><div class="event-title">${esc(actionNames[e.action] || e.action)}</div><div class="event-detail">${esc(e.actor)} · ${date(e.created_at)}</div></div></div>`).join('')}</div>` : empty('ยังไม่มีกิจกรรม','กิจกรรมใหม่จะแสดงที่นี่','clock');
}
async function render() {
  if ($('#console').hidden) return;
  const version = ++renderVersion;
  currentPage = location.hash.slice(1).split('?')[0] || 'overview';
  if (!titles[currentPage]) currentPage = 'overview';
  $('#breadcrumb').textContent = titles[currentPage];
  document.querySelectorAll('nav a').forEach(a => { a.classList.toggle('active',a.dataset.page===currentPage); if(a.dataset.page===currentPage) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  $('#content').innerHTML = '<div class="loading" role="status">กำลังโหลดข้อมูลจากเซิร์ฟเวอร์…</div>';
  try {
    const data = await api('/overview');
    if (version !== renderVersion || $('#console').hidden) return;
    state = data; $('#nav-count').textContent=state.workspaces.length; $('#server-state').textContent='เชื่อมต่อแล้ว · v'+state.version; $('#updated-at').textContent='อัปเดต '+new Date().toLocaleTimeString('th-TH');
    if (currentPage==='overview') overview();
    if (currentPage==='workspaces') workspaces();
    if (currentPage==='files') await filePage(version);
    if (currentPage==='versions') await versionControlPage(version);
    if (currentPage==='history') await history(version);
    if (currentPage==='settings') settings();
  } catch (error) {
    if (version !== renderVersion) return;
    $('#server-state').textContent='เชื่อมต่อไม่สำเร็จ';
    $('#content').innerHTML=`<div class="failure"><h2>โหลดข้อมูลไม่สำเร็จ</h2><p>${esc(error.message)}</p><button class="secondary" data-action="refresh">ลองอีกครั้ง</button></div>`;
  }
}
function overview() {
  const active = state.workspaces.filter(w=>!w.suspended).length;
  const stats = [['layers','Workspace ทั้งหมด',state.workspaces.length,`<b>${active} ใช้งานอยู่</b> · ${state.workspaces.length-active} ระงับแล้ว`],['link','การเชื่อมต่อขณะนี้',state.connections.length,'จำนวน WebSocket ที่เชื่อมต่ออยู่'],['file','เอกสารที่ซิงก์',state.stats.documents,'รวมเอกสารและ metadata ของ Vault'],['server','พื้นที่ข้อมูลเอกสาร',bytes(state.stats.bytes),'ขนาด Yjs snapshots · ไม่รวมไฟล์แนบ']];
  $('#content').innerHTML=heading('ภาพรวมระบบ','ดูแลทุก Workspace และติดตามการซิงก์ได้จากที่เดียว',newButton())+`<div class="stats">${stats.map(([i,l,v,s])=>`<article class="stat"><span class="stat-label">${l}</span><span class="stat-icon">${icon(i)}</span><strong>${v}</strong><small>${s}</small></article>`).join('')}</div><div class="overview-grid"><section><div class="panel"><div class="panel-heading"><div><div class="split-heading"><h2>Workspace ล่าสุด</h2><span class="count">${state.workspaces.length}</span></div><p>พื้นที่ทำงานทั้งหมดบนเซิร์ฟเวอร์ของคุณ</p></div><a class="text-button" href="#workspaces">ดูทั้งหมด →</a></div>${workspaceRows(state.workspaces.slice(0,5),true)}</div><div class="server-panel"><h2>${icon('shield')}คุณเป็นผู้ดูแลข้อมูลของคุณเอง</h2><p>จัดการสิทธิ์และการเข้าถึง Workspace ได้จากหน้าจัดการ การเปลี่ยนแปลงของแอดมินจะถูกบันทึกไว้ในประวัติกิจกรรม</p><a class="text-button" href="#settings">การตั้งค่าความปลอดภัย →</a></div></section><section><div class="panel"><div class="panel-heading"><div><h2>กิจกรรมล่าสุด</h2><p>ความเคลื่อนไหวจากทั้งระบบ</p></div><a class="text-button" href="#history">ดูทั้งหมด →</a></div>${eventItems(state.events)}</div><div class="server-panel"><h2>${icon('server')}สถานะเซิร์ฟเวอร์</h2><div class="server-row"><span>บริการ</span><span class="badge">พร้อมใช้งาน</span></div><div class="server-row"><span>เวอร์ชัน</span><span>v${state.version}</span></div><div class="server-row"><span>ทำงานต่อเนื่อง</span><span>${Math.floor(state.uptime/3600)} ชม. ${Math.floor(state.uptime/60)%60} นาที</span></div></div></section></div>`;
}
function workspaces() {
  $('#content').innerHTML=heading('จัดการ Workspace','สร้าง แก้ไข และควบคุมการเข้าถึง Vault ทั้งหมด',newButton())+`<section class="panel"><div class="panel-heading"><h2>Workspace ทั้งหมด <span class="count">${state.workspaces.length}</span></h2></div><div class="toolbar"><div class="search-wrap">${icon('search')}<input id="workspace-search" aria-label="ค้นหา Workspace" placeholder="ค้นหาชื่อ Workspace…" value="${esc(workspaceSearch)}"></div><span class="hint">คลิกรหัสเชิญเพื่อคัดลอก</span></div><div id="workspace-table"></div></section>`;
  const draw=()=>{const rows=state.workspaces.filter(w=>w.name.toLowerCase().includes(workspaceSearch.toLowerCase()));$('#workspace-table').innerHTML=rows.length?workspaceRows(rows):empty('ไม่พบ Workspace','สร้าง Workspace ใหม่หรือเปลี่ยนคำค้นหา');};draw();
  $('#workspace-search').oninput=e=>{workspaceSearch=e.target.value;draw();};
}
async function filePage(version) {
  if (!state.workspaces.some(w=>w.id===selectedWorkspace)) selectedWorkspace=state.workspaces[0]?.id || '';
  $('#content').innerHTML=heading('ไฟล์ทั้งหมด','ดูไฟล์ ดาวน์โหลด และจัดการข้อมูลภายใน Workspace')+`<section class="panel"><div class="toolbar"><select id="workspace-select" aria-label="เลือก Workspace">${state.workspaces.map(w=>`<option value="${w.id}" ${w.id===selectedWorkspace?'selected':''}>${esc(w.name)}</option>`).join('')}</select><div class="search-wrap">${icon('search')}<input id="file-search" placeholder="ค้นหาชื่อหรือ path ของไฟล์…" aria-label="ค้นหาไฟล์" value="${esc(fileSearch)}"></div></div><div id="file-table">${empty('ยังไม่มี Workspace','สร้าง Workspace ก่อนเพื่อดูไฟล์','file')}</div></section><p class="hint">การลบไฟล์จะซิงก์ไปยัง Vault ที่เชื่อมต่ออยู่ การลบโฟลเดอร์จะรวมไฟล์ภายในทั้งหมด</p>`;
  $('#workspace-select').onchange=e=>{selectedWorkspace=e.target.value;render();};
  $('#file-search').oninput=e=>{fileSearch=e.target.value;drawFiles();};
  if(selectedWorkspace) { const data=await api(`/workspaces/${selectedWorkspace}/files`); if(version!==renderVersion)return; files=data.files;drawFiles(); }
}
function drawFiles() {
  const rows=files.filter(f=>String(f.path).toLowerCase().includes(fileSearch.toLowerCase())).sort((a,b)=>String(a.path).localeCompare(String(b.path)));
  $('#file-table').innerHTML=rows.length?`<div class="table-scroll"><table><thead><tr><th>ชื่อ / PATH</th><th>ประเภท</th><th>ขนาด</th><th>แก้ไขล่าสุด</th><th>จัดการ</th></tr></thead><tbody>${rows.map(f=>`<tr><td class="wrap"><button class="text-button" data-action="rename-file" data-id="${esc(f.id)}">${esc(f.path)}</button></td><td><span class="chip">${esc(f.kind)}</span></td><td>${f.kind==='attachment'?bytes(f.size):'—'}</td><td class="muted">${date(f.updatedAt)}</td><td><div class="actions">${f.kind!=='folder'?`<button class="icon-button" aria-label="ประวัติ ${esc(f.path)}" data-action="versions" data-id="${esc(f.id)}">${icon('clock')}</button><a class="icon-button" aria-label="ดาวน์โหลด ${esc(f.path)}" href="/api/admin/workspaces/${selectedWorkspace}/files/${encodeURIComponent(f.id)}/download">${icon('download')}</a>`:''}<button class="icon-button" aria-label="ลบ ${esc(f.path)}" data-action="delete-file" data-id="${esc(f.id)}">${icon('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('ไม่พบไฟล์','ไฟล์จะปรากฏหลัง Obsidian ซิงก์ metadata มายังเซิร์ฟเวอร์','file');
}
async function history(version) {
  const result=await api(`/history?page=${historyPage}&search=${encodeURIComponent(historySearch)}`);
  if(version!==renderVersion)return;
  $('#content').innerHTML=heading('ประวัติกิจกรรม','ตรวจสอบการเข้าสู่ระบบ การจัดการ Workspace และการซิงก์')+`<section class="panel"><div class="panel-heading"><h2>บันทึกกิจกรรม <span class="count">${result.total}</span></h2><button class="secondary" data-action="export">${icon('download')}ส่งออกหน้านี้</button></div><form id="history-search-form" class="toolbar"><div class="search-wrap">${icon('search')}<input id="history-search" placeholder="ค้นหาผู้ใช้ กิจกรรม หรือ Workspace ID…" aria-label="ค้นหาประวัติ" value="${esc(historySearch)}"></div><button type="submit" class="secondary">ค้นหา</button></form>${result.events.length?`<div class="table-scroll"><table><thead><tr><th>กิจกรรม</th><th>ผู้ดำเนินการ</th><th>WORKSPACE / รายละเอียด</th><th>เวลา</th></tr></thead><tbody>${result.events.map(e=>`<tr><td>${esc(actionNames[e.action]||e.action)}</td><td>${esc(e.actor)}</td><td class="wrap"><span class="mono">${esc(e.workspace_id || '—')}</span>${e.detail?`<div class="hint">${esc(e.detail)}</div>`:''}</td><td class="muted">${date(e.created_at)}</td></tr>`).join('')}</tbody></table></div>`:empty('ยังไม่พบกิจกรรม','ลองเปลี่ยนคำค้นหา หรือกลับมาตรวจสอบหลังมีการใช้งาน','clock')}<div class="pagination"><span>หน้า ${historyPage} / ${Math.max(1,Math.ceil(result.total/50))} · หน้าละ 50 รายการ</span><div class="actions"><button class="secondary" data-action="prev" ${historyPage<=1?'disabled':''}>ก่อนหน้า</button><button class="secondary" data-action="next" ${historyPage*50>=result.total?'disabled':''}>ถัดไป</button></div></div></section><p class="hint">ระบบเริ่มเก็บประวัติหลังติดตั้ง Admin Console · การบันทึกเอกสารแสดงการซิงก์ snapshot ไม่ใช่ประวัติแก้ไขข้อความรายเวอร์ชัน</p>`;
  $('#history-search-form').onsubmit=e=>{e.preventDefault();historySearch=$('#history-search').value;historyPage=1;render();};
  $('[data-action="export"]').onclick=()=>{ const blob=new Blob([JSON.stringify(result.events,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`9sync-history-page-${historyPage}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); };
}
function settings() {
  $('#content').innerHTML=heading('ตั้งค่าระบบ','ดูสถานะเซิร์ฟเวอร์และดูแลความปลอดภัยของบัญชีแอดมิน')+`<div class="settings-grid"><section class="panel"><div class="panel-heading"><h2>บัญชีผู้ดูแลระบบ</h2>${icon('shield')}</div><form id="password-form" class="panel-body"><p>ลงชื่อเข้าใช้เป็น <b>${esc(account)}</b> · เมื่อเปลี่ยนรหัสผ่าน ระบบจะออกจากทุกเซสชัน</p><div class="form-field"><label for="current-password">รหัสผ่านปัจจุบัน</label><input type="password" id="current-password" autocomplete="current-password" required maxlength="1024"></div><div class="form-field"><label for="new-password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร)</label><input type="password" id="new-password" autocomplete="new-password" minlength="12" maxlength="1024" required></div><div class="form-field"><label for="confirm-password">ยืนยันรหัสผ่านใหม่</label><input type="password" id="confirm-password" autocomplete="new-password" minlength="12" maxlength="1024" required></div><p id="password-error" class="error" role="alert"></p><button class="primary" type="submit">เปลี่ยนรหัสผ่าน</button></form></section><section class="panel"><div class="panel-heading"><h2>ข้อมูลระบบ</h2>${icon('server')}</div><div class="panel-body"><div class="server-row"><span>บริการ</span><b>9sync Server</b></div><div class="server-row"><span>เวอร์ชัน</span><span>${state.version}</span></div><div class="server-row"><span>Workspace</span><span>${state.workspaces.length}</span></div><div class="server-row"><span>การเชื่อมต่อ</span><span>${state.connections.length} WebSocket</span></div><div class="server-row"><span>เซสชันแอดมิน</span><span>8 ชั่วโมง</span></div><p class="hint">ค่าฐานข้อมูล พื้นที่จัดเก็บ และ HTTPS กำหนดผ่าน environment ของเซิร์ฟเวอร์</p><p class="hint">ระบบปัจจุบันใช้สิทธิ์เข้าถึงร่วมกันต่อ Workspace การเพิกถอนสิทธิ์จะตัดการเชื่อมต่อทุกเครื่อง และต้องเข้าร่วมด้วยรหัสเชิญใหม่</p></div></section></div>`;
  $('#password-form').onsubmit=async e=>{e.preventDefault();$('#password-error').textContent='';if($('#new-password').value!==$('#confirm-password').value){$('#password-error').textContent='รหัสผ่านใหม่ไม่ตรงกัน';return;}e.submitter.disabled=true;try{await send('/password','POST',{currentPassword:$('#current-password').value,password:$('#new-password').value});showLogin();toast('เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบอีกครั้ง');}catch(error){$('#password-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
}
function modal(title, content, submit, label='บันทึก', destructive=false) {
  $('#modal-title').textContent=title;$('#modal-content').innerHTML=content;$('#modal-error').textContent='';$('#modal-submit').textContent=label;$('#modal-submit').className=destructive?'danger':'primary';$('#modal-submit').disabled=false;
  $('#modal-form').onsubmit=async e=>{e.preventDefault();$('#modal-submit').disabled=true;$('#modal-error').textContent='';try{await submit(new FormData(e.target));$('#modal').close();toast('ดำเนินการเรียบร้อยแล้ว');await render();}catch(error){$('#modal-error').textContent=error.message;}finally{$('#modal-submit').disabled=false;}};
  $('#modal').showModal();
}
$('#modal-close').onclick=$('#modal-cancel').onclick=()=>$('#modal').close();
function manage(id) {
  const w=state.workspaces.find(w=>w.id===id);if(!w)return;
  modal('จัดการ Workspace',`<div class="form-field"><label for="edit-name">ชื่อ Workspace</label><input id="edit-name" name="name" value="${esc(w.name)}" required maxlength="120"></div><div class="form-field"><label for="edit-status">สถานะการซิงก์</label><select id="edit-status" name="suspended"><option value="false" ${!w.suspended?'selected':''}>ใช้งานอยู่</option><option value="true" ${w.suspended?'selected':''}>ระงับการซิงก์</option></select></div><p class="mono">ID: ${esc(w.id)}</p><p>รหัสเชิญ: <b class="mono">${esc(w.invite_code)}</b></p><div class="actions"><button type="button" class="secondary" id="view-files">ดูไฟล์</button><button type="button" class="secondary" id="rotate-invite">เปลี่ยนรหัสเชิญ</button><button type="button" class="danger" id="revoke-access">เพิกถอนสิทธิ์ทั้งหมด</button><button type="button" class="danger" id="delete-workspace">ลบ Workspace</button></div>`, data=>send(`/workspaces/${id}`,'PATCH',{name:data.get('name'),suspended:data.get('suspended')==='true'}));
  $('#view-files').onclick=()=>{selectedWorkspace=id;$('#modal').close();if(location.hash==='#files')render();else location.hash='files';};
  $('#rotate-invite').onclick=()=>{ $('#modal').close();modal('เปลี่ยนรหัสเชิญ','<p>รหัสเชิญเดิมจะใช้ไม่ได้ การเชื่อมต่อเดิมยังทำงานต่อได้</p>',()=>send(`/workspaces/${id}/rotate-invite`,'POST',{}),'เปลี่ยนรหัสเชิญ'); };
  $('#revoke-access').onclick=()=>{ $('#modal').close();modal('เพิกถอนสิทธิ์ทั้งหมด','<p>ทุกเครื่องจะถูกตัดการเชื่อมต่อ Token และรหัสเชิญเดิมจะใช้ไม่ได้ ต้องให้ทุกเครื่องเข้าร่วม Workspace ใหม่</p>',()=>send(`/workspaces/${id}/revoke`,'POST',{}),'เพิกถอนสิทธิ์',true); };
  $('#delete-workspace').onclick=()=>{ $('#modal').close();modal('ลบ Workspace',`<p>ลบข้อมูลเอกสารบนเซิร์ฟเวอร์ของ <b>${esc(w.name)}</b> และตัดการเชื่อมต่อทั้งหมด การลบนี้ย้อนกลับไม่ได้ ไฟล์แนบส่วนกลางยังถูกเก็บไว้เพราะอาจใช้ร่วมกับ Workspace อื่น</p><label for="confirmation">พิมพ์ชื่อ ${esc(w.name)} เพื่อยืนยัน</label><input id="confirmation" name="confirmation" required autocomplete="off">`,data=>send(`/workspaces/${id}`,'DELETE',{confirmation:data.get('confirmation')}),'ลบ Workspace',true); };
}
$('#content').addEventListener('click',async e=>{
  const button=e.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(action==='refresh')render();
  if(action==='create')modal('สร้าง Workspace','<label for="new-name">ชื่อ Workspace</label><input id="new-name" name="name" placeholder="เช่น Product team" required maxlength="120"><p>ใช้รหัสเชิญจากหน้า Workspace เพื่อเชื่อมต่อ Obsidian</p>',data=>send('/workspaces','POST',{name:data.get('name')}),'สร้าง Workspace');
  if(action==='manage')manage(button.dataset.id);
  if(action==='copy'){try{await navigator.clipboard.writeText(button.dataset.value);toast('คัดลอกรหัสเชิญแล้ว');}catch{toast('คัดลอกไม่ได้ กรุณาเลือกรหัสเชิญแล้วคัดลอกด้วยตนเอง');}}
  if(action==='prev'){historyPage--;render();}if(action==='next'){historyPage++;render();}
  if(action==='versions')openVersionHistory(selectedWorkspace,button.dataset.id);
  if(action==='rename-file'){const f=files.find(f=>f.id===button.dataset.id);if(!f)return;modal('เปลี่ยนชื่อหรือย้ายไฟล์',`<label for="edit-path">Path ใหม่</label><input id="edit-path" name="path" value="${esc(f.path)}" required maxlength="500"><p>การเปลี่ยนแปลงจะซิงก์ไปยัง Vault ที่เชื่อมต่ออยู่ หากเป็นโฟลเดอร์จะย้ายไฟล์ภายในไปด้วย</p>`,data=>send(`/workspaces/${selectedWorkspace}/files/${encodeURIComponent(f.id)}`,'PATCH',{path:data.get('path')}));}
  if(action==='delete-file'){const f=files.find(f=>f.id===button.dataset.id);if(!f)return;modal('ลบไฟล์',`<p>การลบ <b>${esc(f.path)}</b> จะซิงก์ไปยัง Vault ที่เชื่อมต่ออยู่${f.kind==='folder'?' รวมไฟล์ภายในโฟลเดอร์ทั้งหมด':''}</p><label for="confirmation">พิมพ์ path ของไฟล์เพื่อยืนยัน</label><input id="confirmation" name="confirmation" required autocomplete="off">`,data=>send(`/workspaces/${selectedWorkspace}/files/${encodeURIComponent(f.id)}`,'DELETE',{confirmation:data.get('confirmation')}),'ลบไฟล์',true);}
});
(async()=>{try{const data=await api('/me');account=data.username;showConsole();}catch{showLogin();}})();

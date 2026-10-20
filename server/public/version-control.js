let vcPage=1,vcSearch='',vcWorkspace='',vcRequest=0;
async function versionControlPage(renderToken) {
  if(!state.workspaces.some(w=>w.id===vcWorkspace))vcWorkspace=state.workspaces[0]?.id||'';
  $('#content').innerHTML=heading('ประวัติเวอร์ชัน','บันทึกจุดสำคัญ เปรียบเทียบ และกู้คืนไฟล์ รวมถึงไฟล์ที่ลบแล้ว')+`<section class="panel"><div class="toolbar"><select id="vc-workspace" aria-label="เลือก Workspace สำหรับประวัติ">${state.workspaces.map(w=>`<option value="${w.id}" ${w.id===vcWorkspace?'selected':''}>${esc(w.name)}</option>`).join('')}</select><form id="vc-search-form" class="actions"><input id="vc-search" aria-label="ค้นหาไฟล์ย้อนหลัง" placeholder="ค้นหา path รวมไฟล์ที่ลบแล้ว…" value="${esc(vcSearch)}"><button class="secondary">ค้นหา</button></form></div><div id="vc-files" class="loading">กำลังโหลดประวัติ…</div></section><p class="hint">เริ่มเก็บประวัติหลังอัปเดตเซิร์ฟเวอร์ · Markdown บันทึกหลังหยุดพิมพ์ 1 วินาที หรืออย่างน้อยทุก 10 วินาทีระหว่างพิมพ์ต่อเนื่อง · เวอร์ชันเก็บไว้จนกว่าจะลบ Workspace</p>`;
  $('#vc-workspace').onchange=e=>{vcWorkspace=e.target.value;vcPage=1;render();};
  $('#vc-search-form').onsubmit=e=>{e.preventDefault();vcSearch=$('#vc-search').value;vcPage=1;render();};
  if(!vcWorkspace){$('#vc-files').innerHTML=empty('ยังไม่มี Workspace','สร้าง Workspace และเริ่มซิงก์ก่อนดูประวัติ');return;}
  const data=await api(`/workspaces/${vcWorkspace}/version-control/files?page=${vcPage}&search=${encodeURIComponent(vcSearch)}`);
  if(renderToken!==renderVersion)return;
  $('#vc-files').className='';
  $('#vc-files').innerHTML=data.files.length?`<div class="table-scroll"><table><thead><tr><th>ไฟล์</th><th>สถานะ</th><th>ประเภท</th><th>เวอร์ชันล่าสุด</th><th>จัดการ</th></tr></thead><tbody>${data.files.map(f=>`<tr><td class="wrap">${esc(f.path)}</td><td><span class="badge ${f.deleted?'paused':''}">${f.deleted?'ลบแล้ว':'ใช้งานอยู่'}</span></td><td>${esc(f.kind)}</td><td>${date(f.created_at)}</td><td><button class="text-button" data-vc-file="${esc(f.file_id)}">เปิดประวัติ →</button></td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>หน้า ${vcPage} · ${data.total} ไฟล์</span><div class="actions"><button id="vc-prev" class="secondary" ${vcPage<=1?'disabled':''}>ก่อนหน้า</button><button id="vc-next" class="secondary" ${vcPage*50>=data.total?'disabled':''}>ถัดไป</button></div></div>`:empty('ยังไม่มีเวอร์ชันที่ตรงคำค้นหา','ซิงก์ไฟล์หรือแก้ไขโน้ตเพื่อเริ่มเก็บประวัติ','clock');
  $('#vc-prev')?.addEventListener('click',()=>{vcPage--;render();});$('#vc-next')?.addEventListener('click',()=>{vcPage++;render();});
  document.querySelectorAll('[data-vc-file]').forEach(button=>button.onclick=()=>openVersionHistory(vcWorkspace,button.dataset.vcFile));
}
async function openVersionHistory(workspaceId,fileId,page=1) {
  const request=++vcRequest;
  const root=`/workspaces/${workspaceId}/version-control`;
  try {
    const data=await api(`${root}/files/${encodeURIComponent(fileId)}/versions?page=${page}`);
    if(request!==vcRequest)return;
    if(!data.versions.length){toast('ยังไม่มีประวัติของไฟล์นี้');return;}
    const dialog=$('#version-dialog');dialog.innerHTML=`<div class="modal-heading"><div><h2>ประวัติเวอร์ชัน</h2><p class="hint wrap">${esc(data.versions[0].path)}</p></div><button id="vc-close" class="icon-button" aria-label="ปิดประวัติ">×</button></div><div class="version-layout"><section><form id="vc-checkpoint" class="checkpoint-form"><label for="vc-message">บันทึกจุดสำคัญด้วยตนเอง</label><input id="vc-message" maxlength="200" placeholder="เช่น ก่อนแก้เนื้อหาบทที่ 1"><button class="secondary" type="submit">บันทึกเวอร์ชัน</button></form><div class="version-list">${data.versions.map(v=>`<button type="button" class="version-item" data-vc-version="${v.id}"><b>#${v.id} · ${esc(versionReason(v.reason))}</b><small>${date(v.created_at)} · ${esc(v.actor)}</small><span>${esc(v.message||v.path)}${v.deleted?' · ลบแล้ว':''}</span></button>`).join('')}</div><div class="actions"><button id="vc-older" class="secondary" ${page*50>=data.total?'disabled':''}>เก่ากว่า</button><button id="vc-newer" class="secondary" ${page<=1?'disabled':''}>ใหม่กว่า</button></div></section><section id="vc-detail" class="version-detail"><p class="hint">เลือกเวอร์ชันเพื่อดูรายละเอียด</p></section></div><p id="vc-error" class="error" role="alert"></p>`;
    if(!dialog.open)dialog.showModal();
    $('#vc-close').onclick=()=>{vcRequest++;dialog.close();};
    $('#vc-older').onclick=()=>openVersionHistory(workspaceId,fileId,page+1);$('#vc-newer').onclick=()=>openVersionHistory(workspaceId,fileId,page-1);
    document.querySelectorAll('[data-vc-version]').forEach(b=>b.onclick=()=>selectVersion(b.dataset.vcVersion));
    $('#vc-checkpoint').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await send(`${root}/files/${encodeURIComponent(fileId)}/checkpoint`,'POST',{message:$('#vc-message').value});toast('บันทึกเวอร์ชันแล้ว');await openVersionHistory(workspaceId,fileId);}catch(error){$('#vc-error').textContent=error.message;e.submitter.disabled=false;}};
    async function selectVersion(versionId,compareTo='') {
      const selection=++vcRequest;$('#vc-error').textContent='';$('#vc-detail').innerHTML='<p class="hint">กำลังโหลดเวอร์ชัน…</p>';
      try {
        const detail=await api(`${root}/versions/${versionId}${compareTo?'?compareTo='+encodeURIComponent(compareTo):''}`);
        if(selection!==vcRequest||!dialog.open)return;
        const v=detail.version;
        document.querySelectorAll('[data-vc-version]').forEach(b=>{b.classList.toggle('selected',b.dataset.vcVersion===String(v.id));b.setAttribute('aria-pressed',String(b.dataset.vcVersion===String(v.id)));});
        $('#vc-detail').innerHTML=`<h2>เวอร์ชัน #${v.id}</h2><p class="hint wrap">${esc(v.path)} · ${date(v.created_at)}${v.deleted?' · ก่อน/ขณะลบไฟล์':''}</p><label for="vc-compare">เปรียบเทียบเวอร์ชันนี้กับ</label><select id="vc-compare"><option value="">สถานะปัจจุบัน${detail.current?.deleted?' (ลบแล้ว)':''}</option>${data.versions.filter(row=>row.id!==v.id).map(row=>`<option value="${row.id}" ${String(row.id)===compareTo?'selected':''}>#${row.id} · ${date(row.created_at)}</option>`).join('')}</select><div class="version-diff" id="vc-diff"></div><div class="actions"><a class="secondary" href="/api/admin${root}/versions/${v.id}/download">ดาวน์โหลดเวอร์ชันนี้</a><button class="primary" id="vc-restore">กู้คืนเวอร์ชันนี้</button></div><div id="vc-confirm" hidden><p class="hint">จะกู้ทั้งเนื้อหาและ path เป็น ${esc(v.path)} และซิงก์ไปทุกเครื่อง ระบบจะเก็บสถานะก่อนกู้คืนไว้อีกเวอร์ชัน</p><button class="danger" id="vc-confirm-restore">ยืนยันกู้คืน #${v.id}</button></div>`;
        $('#vc-compare').onchange=e=>selectVersion(versionId,e.target.value);
        const diff=$('#vc-diff');
        if(detail.diff) {
          const legend=document.createElement('p');legend.className='hint';legend.textContent=`− ${detail.diff.removed} บรรทัดในเวอร์ชันที่เลือก / + ${detail.diff.added} บรรทัดในฝั่งเปรียบเทียบ${detail.diff.simplified?' · แสดงแบบย่อสำหรับไฟล์ขนาดใหญ่':''}`;diff.append(legend);
          const pre=document.createElement('pre');pre.className='diff-lines';for(const line of detail.diff.lines){const span=document.createElement('span');span.className='diff-'+line.type;span.textContent=(line.type==='added'?'+ ':line.type==='removed'?'− ':'  ')+line.text+(line.text.endsWith('\n')?'':'\n');pre.append(span);}diff.append(pre);
        } else diff.innerHTML='<p class="hint">ไฟล์แนบเก็บเป็นเวอร์ชันทั้งไฟล์ ดาวน์โหลดเพื่อตรวจสอบเนื้อหาได้</p>';
        $('#vc-restore').onclick=()=>$('#vc-confirm').hidden=false;
        $('#vc-confirm-restore').onclick=async e=>{e.target.disabled=true;try{await send(`${root}/versions/${versionId}/restore`,'POST',{expectedFingerprint:detail.current?.fingerprint});toast('กู้คืนและเก็บเวอร์ชันก่อนกู้คืนแล้ว');await openVersionHistory(workspaceId,fileId);}catch(error){$('#vc-error').textContent=error.message;e.target.disabled=false;}};
      }catch(error){if(selection===vcRequest)$('#vc-error').textContent=error.message;}
    }
    await selectVersion(String(data.versions[0].id));
  }catch(error){toast(error.message);}
}
function versionReason(reason){return ({automatic:'อัตโนมัติ',metadata:'สร้าง / ย้ายไฟล์','before-change':'ก่อนเปลี่ยนแปลง',deleted:'ลบไฟล์',checkpoint:'บันทึกด้วยตนเอง',baseline:'ข้อมูลเริ่มต้น','before-restore':'ก่อนกู้คืน',restore:'กู้คืน'})[reason]||reason;}

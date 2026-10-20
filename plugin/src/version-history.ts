import { App, Modal, Notice, requestUrl } from 'obsidian';

interface Connection { serverUrl: string; workspaceId: string; token: string }
interface FileHistory { file_id: string; path: string; deleted: boolean }
interface Revision { id: string; path: string; reason: string; actor: string; message: string; deleted: boolean; created_at: string; kind: string }
interface Page<T> { total: number; page: number; files?: T[]; versions?: T[] }
interface Detail { version: Revision; current: { fingerprint: string; deleted: boolean } | null; diff: { added: number; removed: number; simplified: boolean; lines: { type: string; text: string }[] } | null }
const when = (date: string) => new Date(date).toLocaleString();
const reason = (value: string) => ({ automatic:'Automatic',metadata:'Created / renamed','before-change':'Before change',deleted:'Deleted',checkpoint:'Checkpoint',baseline:'Initial baseline','before-restore':'Before restore',restore:'Restored' } as Record<string,string>)[value] || value;

export class VersionHistoryModal extends Modal {
  private sequence = 0;
  private selectedFile: string;
  private filePage = 1;
  private versionPage = 1;
  private search = '';
  constructor(app: App, private connection: Connection, initialFileId = '') { super(app);this.selectedFile=initialFileId; }
  onOpen() { this.modalEl.addClass('nine-sync-history-modal');void this.render(); }
  onClose() { this.sequence++;this.contentEl.empty(); }
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await requestUrl({ url:`${this.connection.serverUrl.replace(/\/$/,'')}/api/workspaces/${encodeURIComponent(this.connection.workspaceId)}/version-control${path}`, method:body===undefined?'GET':'POST', headers:{Authorization:`Bearer ${this.connection.token}`,'Content-Type':'application/json'}, ...(body===undefined?{}:{body:JSON.stringify(body)}), throw:false });
    if(response.status<200 || response.status>=300) {
      let message='Version history request failed. Update the 9sync server if this feature is unavailable.';
      try { message=response.json.error || message; } catch { /* An older server can return HTML. */ }
      throw new Error(`${response.status}: ${message}`);
    }
    return response.json as T;
  }
  private async render() {
    const sequence=++this.sequence;
    const el=this.contentEl;el.empty();el.createEl('h2',{text:'9sync · Version history'});
    el.createEl('p',{text:'Browse snapshots, compare changes, and restore files. Deleted files are included.',cls:'nine-sync-help'});
    const loading=el.createEl('p',{text:'Loading…'});
    try {
      const listing=await this.api<Page<FileHistory>>(`/files?page=${this.filePage}&search=${encodeURIComponent(this.search)}`);
      if(sequence!==this.sequence)return;loading.remove();
      const form=el.createEl('form',{cls:'nine-sync-history-toolbar'});
      const search=form.createEl('input',{type:'search',placeholder:'Search file paths, including deleted files',value:this.search});search.setAttribute('aria-label','Search versioned files');
      form.createEl('button',{text:'Search',type:'submit'});
      form.onsubmit=e=>{e.preventDefault();this.search=search.value;this.filePage=1;this.selectedFile='';this.versionPage=1;void this.render();};
      const files=listing.files || [];
      const label=el.createEl('label',{text:'File'});label.htmlFor='nine-history-file';
      const select=el.createEl('select',{cls:'nine-sync-history-select'});select.id='nine-history-file';
      if(!this.selectedFile)this.selectedFile=files[0]?.file_id || '';
      if(this.selectedFile && !files.some(f=>f.file_id===this.selectedFile))select.createEl('option',{value:this.selectedFile,text:'Selected file'});
      for(const file of files)select.createEl('option',{value:file.file_id,text:`${file.path}${file.deleted?' (deleted)':''}`});
      select.value=this.selectedFile;select.onchange=()=>{this.selectedFile=select.value;this.versionPage=1;void this.render();};
      const pagination=el.createDiv({cls:'nine-sync-history-toolbar'});
      const prev=pagination.createEl('button',{text:'Previous files'});prev.disabled=this.filePage<=1;prev.onclick=()=>{this.filePage--;this.selectedFile='';void this.render();};
      pagination.createEl('span',{text:`Page ${this.filePage} · ${listing.total} files`});
      const next=pagination.createEl('button',{text:'Next files'});next.disabled=this.filePage*50>=listing.total;next.onclick=()=>{this.filePage++;this.selectedFile='';void this.render();};
      if(!this.selectedFile){el.createEl('p',{text:'No saved versions yet. Sync or edit a file to start recording history.'});return;}
      const history=await this.api<Page<Revision>>(`/files/${encodeURIComponent(this.selectedFile)}/versions?page=${this.versionPage}`);
      if(sequence!==this.sequence)return;
      const revisions=history.versions || [];
      if(!revisions.length){el.createEl('p',{text:'No versions available for this file yet.'});return;}
      el.createEl('h3',{text:revisions[0].path});
      const checkpoint=el.createEl('form',{cls:'nine-sync-history-toolbar'});
      const message=checkpoint.createEl('input',{placeholder:'Checkpoint message (optional)'});message.maxLength=200;message.setAttribute('aria-label','Checkpoint message');
      const save=checkpoint.createEl('button',{text:'Save checkpoint',type:'submit'});save.disabled=revisions[0].deleted;
      checkpoint.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await this.api(`/files/${encodeURIComponent(this.selectedFile)}/checkpoint`,{message:message.value});this.versionPage=1;new Notice('Version saved');void this.render();}catch(error){new Notice(String(error));save.disabled=false;}};
      const layout=el.createDiv({cls:'nine-sync-history-layout'}),list=layout.createDiv({cls:'nine-sync-history-list'}),detail=layout.createDiv({cls:'nine-sync-history-detail'});
      const paging=list.createDiv({cls:'nine-sync-history-toolbar'});
      const newer=paging.createEl('button',{text:'Newer'});newer.disabled=this.versionPage<=1;newer.onclick=()=>{this.versionPage--;void this.render();};
      const older=paging.createEl('button',{text:'Older'});older.disabled=this.versionPage*50>=history.total;older.onclick=()=>{this.versionPage++;void this.render();};
      const buttons: HTMLButtonElement[]=[];
      for(const revision of revisions) {
        const button=list.createEl('button',{cls:'nine-sync-history-item'});button.createEl('strong',{text:`#${revision.id} · ${reason(revision.reason)}`});button.createEl('small',{text:`${when(revision.created_at)} · ${revision.actor}`});button.createEl('span',{text:revision.message||revision.path});buttons.push(button);
        button.onclick=()=>void show(revision.id);
      }
      let detailSequence=0;
      const show=async (versionId: string,compareTo='') => {
        const request=++detailSequence;detail.empty();detail.createEl('p',{text:'Loading version…'});
        try {
          const data=await this.api<Detail>(`/versions/${versionId}${compareTo?'?compareTo='+encodeURIComponent(compareTo):''}`);
          if(request!==detailSequence || sequence!==this.sequence)return;
          detail.empty();buttons.forEach((b,i)=>{b.toggleClass('is-active',revisions[i].id===versionId);b.setAttribute('aria-pressed',String(revisions[i].id===versionId));});
          detail.createEl('h3',{text:`Version #${versionId}`});detail.createEl('p',{text:`${data.version.path} · ${when(data.version.created_at)}`,cls:'nine-sync-help'});
          const compareLabel=detail.createEl('label',{text:'Compare selected version with'});const compare=detail.createEl('select',{cls:'nine-sync-history-select'});compare.id='nine-history-compare';compareLabel.htmlFor=compare.id;compare.createEl('option',{value:'',text:`Current state${data.current?.deleted?' (deleted)':''}`});
          for(const v of revisions)if(v.id!==versionId)compare.createEl('option',{value:v.id,text:`#${v.id} · ${when(v.created_at)}`});compare.value=compareTo;compare.onchange=()=>void show(versionId,compare.value);
          if(data.diff) {
            detail.createEl('p',{text:`− ${data.diff.removed} lines from selected version / + ${data.diff.added} lines in comparison${data.diff.simplified?' · simplified large-file diff':''}`,cls:'nine-sync-help'});
            const pre=detail.createEl('pre',{cls:'nine-sync-diff'});
            for(const line of data.diff.lines)pre.createEl('span',{text:(line.type==='added'?'+ ':line.type==='removed'?'− ':'  ')+line.text+(line.text.endsWith('\n')?'':'\n'),cls:`nine-sync-diff-${line.type}`});
          } else detail.createEl('p',{text:'Attachments are restored as whole files. Use the admin console to download a historical attachment.'});
          const restore=detail.createEl('button',{text:'Restore this version',cls:'mod-cta'});
          const confirm=detail.createDiv({cls:'nine-sync-history-confirm'});confirm.hidden=true;
          confirm.createEl('p',{text:`Restore content and path to ${data.version.path}? This syncs to all connected devices. The state before restoring will be saved as another version.`});
          const yes=confirm.createEl('button',{text:`Confirm restore #${versionId}`,cls:'mod-warning'});
          restore.onclick=()=>{confirm.hidden=false;yes.focus();};
          yes.onclick=async()=>{yes.disabled=true;try{await this.api(`/versions/${versionId}/restore`,{expectedFingerprint:data.current?.fingerprint});new Notice('Restored. The previous state is preserved in version history.');this.versionPage=1;void this.render();}catch(error){detail.createEl('p',{text:String(error),cls:'nine-sync-history-error'});yes.disabled=false;}};
        }catch(error){if(sequence===this.sequence){detail.empty();detail.createEl('p',{text:String(error),cls:'nine-sync-history-error'});}}
      };
      await show(revisions[0].id);
    }catch(error){if(sequence===this.sequence){loading.remove();el.createEl('p',{text:String(error),cls:'nine-sync-history-error'});const retry=el.createEl('button',{text:'Retry'});retry.onclick=()=>void this.render();}}
  }
}

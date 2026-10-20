import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} from 'obsidian';
import {
  Annotation,
  type Range,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { VersionHistoryModal } from './version-history';

interface NineSyncSettings {
  serverUrl: string;
  workspaceId: string;
  token: string;
  userName: string;
  syncMode: 'vault' | 'folder';
  sharedFolder: string;
  excludedPaths: string;
  organizeAttachments: boolean;
  imageFolder: string;
  pdfFolder: string;
  mediaFolder: string;
  otherFileFolder: string;
  workspaceName: string;
  inviteCode: string;
  deviceId: string;
}

const DEFAULT_SETTINGS: NineSyncSettings = {
  serverUrl: 'http://localhost:3001',
  workspaceId: '',
  token: '',
  userName: 'Nai',
  syncMode: 'vault',
  sharedFolder: 'Shared',
  excludedPaths: '.obsidian\n.trash\n.git\n.9sync',
  organizeAttachments: true,
  imageFolder: 'Assets/Images',
  pdfFolder: 'Assets/PDF',
  mediaFolder: 'Assets/Media',
  otherFileFolder: 'Assets/Files',
  workspaceName: 'My Vault',
  inviteCode: '',
  deviceId: '',
};

type EntryKind = 'markdown' | 'attachment' | 'folder';
interface FileRecord {
  id: string;
  path: string;
  kind: EntryKind;
  hash?: string;
  size?: number;
  updatedAt: number;
}

interface RemoteCursorState {
  clientId: number;
  anchor: number;
  head: number;
  name: string;
  color: string;
  colorLight: string;
}

interface MetaChange {
  id: string;
  action: 'add' | 'update' | 'delete';
  oldValue?: FileRecord;
  value?: FileRecord;
}

const FILE_ORIGIN = Symbol('9sync-file-origin');
const INIT_ORIGIN = Symbol('9sync-initial-origin');
const REMOTE_EDITOR_UPDATE = Annotation.define<boolean>();
const SET_REMOTE_CURSORS = StateEffect.define<RemoteCursorState[]>();

const USER_COLORS = [
  ['#30bced', '#30bced33'],
  ['#6eeb83', '#6eeb8333'],
  ['#ffbc42', '#ffbc4233'],
  ['#ecd444', '#ecd44433'],
  ['#ee6352', '#ee635233'],
  ['#9ac2c9', '#9ac2c933'],
  ['#8acb88', '#8acb8833'],
  ['#1be7ff', '#1be7ff33'],
] as const;

function wsBase(serverUrl: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  return url.toString().replace(/\/$/, '');
}

function isInside(folder: string, targetPath: string) {
  const root = normalizePath(folder).replace(/\/$/, '');
  const p = normalizePath(targetPath);
  if (!root) return true;
  return p === root || p.startsWith(`${root}/`);
}

function parsePathList(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => normalizePath(item.trim()).replace(/\/$/, ''))
    .filter(Boolean);
}

function parentFolder(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function applyMinimalDiff(ytext: Y.Text, before: string, after: string) {
  if (before === after) return;
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;

  const deleteCount = before.length - prefix - suffix;
  const insertText = after.slice(prefix, after.length - suffix);
  if (deleteCount > 0) ytext.delete(prefix, deleteCount);
  if (insertText.length > 0) ytext.insert(prefix, insertText);
}

function colorFor(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

class RemoteCursorWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly color: string,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof RemoteCursorWidget && other.name === this.name && other.color === this.color;
  }

  toDOM() {
    const caret = document.createElement('span');
    caret.className = 'nine-sync-remote-caret';
    caret.style.setProperty('--nine-sync-cursor-color', this.color);

    const label = document.createElement('span');
    label.className = 'nine-sync-remote-caret-label';
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }

  ignoreEvent() { return true; }
}

function buildRemoteDecorations(states: RemoteCursorState[], docLength: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];

  for (const state of states) {
    const anchor = clamp(state.anchor, 0, docLength);
    const head = clamp(state.head, 0, docLength);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    if (from !== to) {
      ranges.push(
        Decoration.mark({
          class: 'nine-sync-remote-selection',
          attributes: { style: `--nine-sync-selection-color:${state.colorLight}` },
        }).range(from, to),
      );
    }

    ranges.push(
      Decoration.widget({
        widget: new RemoteCursorWidget(state.name, state.color),
        side: 1,
      }).range(head),
    );
  }

  return Decoration.set(ranges, true);
}

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(SET_REMOTE_CURSORS)) {
        next = buildRemoteDecorations(effect.value, transaction.state.doc.length);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class MarkdownSession {
  readonly ydoc = new Y.Doc();
  readonly ytext = this.ydoc.getText('content');
  readonly provider: WebsocketProvider;
  readonly ready: Promise<void>;

  private resolveReady!: () => void;
  private syncedOnce = false;
  private destroyed = false;

  constructor(
    private manager: SyncManager,
    readonly id: string,
    public path: string,
    private initialLocalText: string,
  ) {
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    this.provider = manager.makeProvider(`workspace:${manager.settings.workspaceId}:doc:${id}`, this.ydoc);
    this.setPresence();

    this.ytext.observe((event, transaction) => {
      if (this.destroyed || !this.syncedOnce) return;
      this.manager.onMarkdownTextChanged(this, event, transaction.origin);
    });

    this.provider.awareness.on('change', () => {
      if (!this.destroyed) this.manager.onAwarenessChanged(this.id);
    });

    this.provider.on('sync', (isSynced: boolean) => {
      if (!isSynced || this.destroyed || this.syncedOnce) return;

      // If the collaborative document is brand new, seed it from the local file.
      // Existing server content wins when it is already present.
      if (this.ytext.length === 0 && this.initialLocalText.length > 0) {
        this.ydoc.transact(() => this.ytext.insert(0, this.initialLocalText), INIT_ORIGIN);
      }

      this.syncedOnce = true;
      this.resolveReady();
      void this.manager.onMarkdownSessionReady(this);
    });
  }

  setPresence() {
    const [color, colorLight] = colorFor(`${this.manager.settings.deviceId}:${this.manager.settings.userName}`);
    this.provider.awareness.setLocalStateField('user', {
      name: this.manager.settings.userName || 'Anonymous',
      color,
      colorLight,
    });
  }

  setCursor(anchor: number, head: number) {
    this.provider.awareness.setLocalStateField('cursor', { anchor, head });
  }

  clearCursor() {
    this.provider.awareness.setLocalStateField('cursor', null);
  }

  remoteCursors(): RemoteCursorState[] {
    const cursors: RemoteCursorState[] = [];
    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === this.ydoc.clientID) continue;
      const user = state?.user as { name?: string; color?: string; colorLight?: string } | undefined;
      const cursor = state?.cursor as { anchor?: number; head?: number } | null | undefined;
      if (!cursor || typeof cursor.anchor !== 'number' || typeof cursor.head !== 'number') continue;
      cursors.push({
        clientId,
        anchor: cursor.anchor,
        head: cursor.head,
        name: user?.name || 'Collaborator',
        color: user?.color || '#30bced',
        colorLight: user?.colorLight || '#30bced33',
      });
    }
    return cursors;
  }

  async applyFileText(next: string) {
    if (this.destroyed) return;
    await this.ready;
    if (this.destroyed) return;
    const current = this.ytext.toString();
    if (current === next) return;
    this.ydoc.transact(() => applyMinimalDiff(this.ytext, current, next), FILE_ORIGIN);
  }

  destroy() {
    this.destroyed = true;
    this.provider.destroy();
    this.ydoc.destroy();
  }
}

class SyncManager {
  readonly metaDoc = new Y.Doc();
  readonly files = this.metaDoc.getMap<FileRecord>('files');
  readonly metaProvider: WebsocketProvider;
  readonly sessions = new Map<string, MarkdownSession>();

  private knownRecords = new Map<string, FileRecord>();
  private appliedHashes = new Map<string, string>();
  private suppressUntil = new Map<string, number>();
  private persistTimers = new Map<string, number>();
  private metaQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private connectionStatus = 'connecting';
  private recoveryTimer: number | null = null;

  constructor(readonly plugin: NineSyncPlugin) {
    this.metaProvider = this.makeProvider(`workspace:${this.settings.workspaceId}:meta`, this.metaDoc);
    this.setMetaPresence();

    this.files.observe((event) => {
      const changes: MetaChange[] = [];
      for (const [id, change] of event.changes.keys) {
        changes.push({
          id,
          action: change.action,
          oldValue: change.oldValue as FileRecord | undefined,
          value: this.files.get(id),
        });
      }
      void this.enqueueMetaTask(() => this.applyMetaChanges(changes));
    });

    this.metaProvider.on('sync', (synced: boolean) => {
      if (!synced) return;
      void this.initialSync();
    });

    this.metaProvider.on('status', ({ status }: { status: string }) => {
      this.connectionStatus = status;
      this.updateStatus();
      if (status === 'connected') void this.enqueueMetaTask(() => this.fullReconcile());
    });

    this.metaProvider.awareness.on('change', () => this.updateStatus());

    // Safety net for file-system events swallowed by another community plugin.
    // The normal path is event-driven; this only repairs missing remote files and
    // discovers new local files that never emitted a usable create callback.
    this.recoveryTimer = window.setInterval(() => {
      void this.recoveryScan();
    }, 2500);
  }

  get settings() { return this.plugin.settings; }

  private setMetaPresence() {
    const [color, colorLight] = colorFor(`${this.settings.deviceId}:${this.settings.userName}`);
    this.metaProvider.awareness.setLocalStateField('user', {
      name: this.settings.userName || 'Anonymous',
      color,
      colorLight,
    });
  }

  private updateStatus() {
    const online = this.metaProvider.awareness.getStates().size;
    const connected = this.connectionStatus === 'connected';
    this.plugin.setStatus(
      connected ? `9sync: connected · ${Math.max(online, 1)} online` : `9sync: ${this.connectionStatus}…`,
      connected,
    );
  }

  makeProvider(room: string, doc: Y.Doc) {
    return new WebsocketProvider(wsBase(this.settings.serverUrl), room, doc, {
      params: { workspace: this.settings.workspaceId, token: this.settings.token },
    });
  }

  private enqueueMetaTask(task: () => Promise<void>) {
    const run = this.metaQueue.then(async () => {
      if (!this.stopped) await task();
    });
    this.metaQueue = run.catch((error) => {
      console.error('[9sync] metadata sync failed', error);
    });
    return run;
  }

  private markSuppressed(path: string, ms = 5000) {
    const normalized = normalizePath(path);
    this.suppressUntil.set(normalized, Date.now() + ms);
  }

  suppressPath(path: string, ms = 5000) {
    this.markSuppressed(path, ms);
  }

  isSuppressed(path: string) {
    const normalized = normalizePath(path);
    const now = Date.now();
    for (const [suppressedPath, until] of this.suppressUntil) {
      if (until < now) {
        this.suppressUntil.delete(suppressedPath);
        continue;
      }
      if (normalized === suppressedPath || normalized.startsWith(`${suppressedPath}/`)) return true;
    }
    return false;
  }

  async initialSync() {
    if (this.stopped) return;
    if (this.files.size === 0) await this.seedFromLocalVault();
    await this.enqueueMetaTask(() => this.fullReconcile());
    await this.plugin.refreshEditorBindings();
  }

  private async seedFromLocalVault() {
    const entries = this.plugin.app.vault.getAllLoadedFiles()
      .filter((file) => file.path && this.plugin.shouldSyncPath(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    this.metaDoc.transact(() => {
      for (const entry of entries) {
        const id = crypto.randomUUID();
        if (entry instanceof TFolder) {
          this.files.set(id, { id, path: entry.path, kind: 'folder', updatedAt: Date.now() });
        } else if (entry instanceof TFile && entry.extension.toLowerCase() === 'md') {
          this.files.set(id, { id, path: entry.path, kind: 'markdown', updatedAt: Date.now() });
        }
      }
    }, FILE_ORIGIN);

    for (const entry of entries) {
      if (entry instanceof TFile && entry.extension.toLowerCase() !== 'md') await this.upsertAttachment(entry);
    }
  }

  findByPath(path: string) {
    const normalized = normalizePath(path);
    for (const [id, record] of this.files.entries()) {
      if (normalizePath(record.path) === normalized) return { id, record };
    }
    return null;
  }

  async onCreate(file: TAbstractFile) {
    if (!this.plugin.shouldSyncPath(file.path) || this.isSuppressed(file.path)) return;

    if (file instanceof TFile && file.extension.toLowerCase() !== 'md') {
      // Give Obsidian's paste/drop pipeline a moment to insert its original link;
      // FileManager can then update that link when we move the attachment.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      file = await this.plugin.routeAttachment(file, this);
      if (!this.plugin.shouldSyncPath(file.path)) return;
    }

    if (this.findByPath(file.path)) return;

    const id = crypto.randomUUID();
    if (file instanceof TFolder) {
      this.files.set(id, { id, path: file.path, kind: 'folder', updatedAt: Date.now() });
    } else if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
      this.files.set(id, { id, path: file.path, kind: 'markdown', updatedAt: Date.now() });
      await this.ensureMarkdownSession(this.files.get(id)!);
      await this.plugin.refreshEditorBindings();
    } else if (file instanceof TFile) {
      await this.upsertAttachment(file, id);
    }
  }

  async onModify(file: TAbstractFile) {
    if (!(file instanceof TFile) || !this.plugin.shouldSyncPath(file.path) || this.isSuppressed(file.path)) return;
    const found = this.findByPath(file.path);

    if (file.extension.toLowerCase() === 'md') {
      if (!found) return this.onCreate(file);

      // While a note is open, CodeMirror -> Y.Text is authoritative. Obsidian
      // may emit modify events for an older autosaved snapshot; feeding that
      // snapshot back into Y.Text can delete freshly typed CRDT content.
      if (this.plugin.isPathOpen(file.path)) return;

      const session = this.sessions.get(found.id) ?? await this.ensureMarkdownSession(found.record);
      await session.applyFileText(await this.plugin.app.vault.read(file));
    } else {
      await this.upsertAttachment(file, found?.id);
    }
  }

  async onRename(file: TAbstractFile, oldPath: string) {
    if (this.isSuppressed(file.path) || this.isSuppressed(oldPath)) return;
    const oldNorm = normalizePath(oldPath);
    let newNorm = normalizePath(file.path);
    const oldSynced = this.plugin.shouldSyncPath(oldNorm);
    let newSynced = this.plugin.shouldSyncPath(newNorm);
    if (!oldSynced && !newSynced) return;

    if (newSynced && file instanceof TFile && file.extension.toLowerCase() !== 'md') {
      file = await this.plugin.routeAttachment(file, this);
      newNorm = normalizePath(file.path);
      newSynced = this.plugin.shouldSyncPath(newNorm);
    }

    // Moving into an excluded/out-of-scope area removes it from the workspace.
    if (oldSynced && !newSynced) {
      const ids: string[] = [];
      for (const [id, record] of this.files.entries()) {
        if (record.path === oldNorm || record.path.startsWith(`${oldNorm}/`)) ids.push(id);
      }
      this.metaDoc.transact(() => ids.forEach((id) => this.files.delete(id)), FILE_ORIGIN);
      return;
    }

    // Moving from an excluded/out-of-scope area into sync scope publishes it.
    if (!oldSynced && newSynced) {
      await this.onCreate(file);
      return;
    }

    const updates: Array<[string, FileRecord]> = [];
    for (const [id, record] of this.files.entries()) {
      if (record.path === oldNorm || record.path.startsWith(`${oldNorm}/`)) {
        updates.push([id, {
          ...record,
          path: newNorm + record.path.slice(oldNorm.length),
          updatedAt: Date.now(),
        }]);
      }
    }

    if (updates.length === 0) {
      await this.onCreate(file);
      return;
    }

    this.metaDoc.transact(() => updates.forEach(([id, record]) => this.files.set(id, record)), FILE_ORIGIN);
    for (const [id, record] of updates) {
      const session = this.sessions.get(id);
      if (session) session.path = record.path;
    }
    await this.plugin.refreshEditorBindings();
  }

  async onDelete(file: TAbstractFile) {
    if (!this.plugin.shouldSyncPath(file.path) || this.isSuppressed(file.path)) return;
    const p = normalizePath(file.path);
    const ids: string[] = [];
    for (const [id, record] of this.files.entries()) {
      if (record.path === p || record.path.startsWith(`${p}/`)) ids.push(id);
    }
    this.metaDoc.transact(() => ids.forEach((id) => this.files.delete(id)), FILE_ORIGIN);
  }

  async ensureMarkdownSession(record: FileRecord) {
    const existingSession = this.sessions.get(record.id);
    if (existingSession) {
      existingSession.path = record.path;
      return existingSession;
    }

    let localText = '';
    const local = this.plugin.app.vault.getAbstractFileByPath(record.path);
    if (local instanceof TFile) localText = await this.plugin.app.vault.read(local);
    const session = new MarkdownSession(this, record.id, record.path, localText);
    this.sessions.set(record.id, session);
    return session;
  }

  async onMarkdownSessionReady(session: MarkdownSession) {
    if (this.stopped) return;

    // An open Markdown editor is the source of disk persistence. Never touch its
    // backing file with vault.modify(), otherwise Obsidian treats our write as
    // an external edit and can merge stale disk text back into the editor.
    // That was the cause of cursor jumps and occasional disappearing text.
    this.plugin.syncEditorsFromYText(session.id, session.ytext.toString());
    if (!this.plugin.isPathOpen(session.path)) {
      await this.applyRemoteMarkdown(session.id, session.path, session.ytext.toString());
    }
    await this.plugin.refreshEditorBindings();
    this.onAwarenessChanged(session.id);
  }

  onMarkdownTextChanged(session: MarkdownSession, event: Y.YTextEvent, origin: unknown) {
    if (this.stopped) return;

    // Apply the CRDT delta directly to visible CodeMirror editors. This keeps
    // the edit granular (insert one character => insert one character remotely)
    // and lets CodeMirror map selections/cursors instead of replacing a large
    // chunk of the document.
    this.plugin.syncEditorsFromYDelta(session.id, event.delta, session.ytext.toString(), origin);

    // Closed files still need a physical .md file kept in sync. Open files are
    // persisted by Obsidian itself after the CodeMirror transaction lands.
    if (!this.plugin.isPathOpen(session.path)) {
      this.scheduleMarkdownPersist(session, session.ytext.toString());
    }
  }

  onAwarenessChanged(id: string) {
    if (this.stopped) return;
    const session = this.sessions.get(id);
    if (!session) return;
    this.plugin.renderRemoteCursors(id, session.remoteCursors());
  }

  updateLocalCursor(id: string, anchor: number, head: number) {
    const session = this.sessions.get(id);
    if (session) session.setCursor(anchor, head);
  }

  clearLocalCursor(id: string) {
    this.sessions.get(id)?.clearCursor();
  }

  async persistMarkdownIfClosed(id: string) {
    const session = this.sessions.get(id);
    if (!session || this.plugin.isPathOpen(session.path)) return;
    await this.applyRemoteMarkdown(session.id, session.path, session.ytext.toString());
  }

  scheduleMarkdownPersist(session: MarkdownSession, text: string) {
    const previous = this.persistTimers.get(session.id);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.persistTimers.delete(session.id);
      if (this.plugin.isPathOpen(session.path)) return;
      void this.applyRemoteMarkdown(session.id, session.path, text);
    }, 350);
    this.persistTimers.set(session.id, timer);
  }

  private async applyRemoteMarkdown(id: string, path: string, text: string) {
    if (this.stopped || this.plugin.isPathOpen(path)) return;
    const normalized = normalizePath(path);
    this.markSuppressed(normalized);
    const existing = this.plugin.app.vault.getAbstractFileByPath(normalized);

    if (existing instanceof TFile) {
      if ((await this.plugin.app.vault.read(existing)) !== text) {
        await this.plugin.app.vault.modify(existing, text);
      }
    } else {
      await this.ensureParent(normalized);
      await this.plugin.app.vault.create(normalized, text);
    }
  }

  private async upsertAttachment(file: TFile, forcedId?: string) {
    const data = await this.plugin.app.vault.readBinary(file);
    const hash = await this.hash(data);
    await this.uploadBlob(hash, data);
    const found = forcedId ? null : this.findByPath(file.path);
    const id = forcedId ?? found?.id ?? crypto.randomUUID();
    this.appliedHashes.set(id, hash);
    this.files.set(id, {
      id,
      path: file.path,
      kind: 'attachment',
      hash,
      size: data.byteLength,
      updatedAt: Date.now(),
    });
  }

  private async applyMetaChanges(changes: MetaChange[]) {
    if (this.stopped || changes.length === 0) return;

    const deletions = changes
      .filter((change) => change.action === 'delete')
      .sort((a, b) => (b.oldValue?.path.length ?? 0) - (a.oldValue?.path.length ?? 0));

    for (const change of deletions) {
      const previous = change.oldValue ?? this.knownRecords.get(change.id);
      if (previous) await this.applyDeletedRecord(change.id, previous);
      this.knownRecords.delete(change.id);
    }

    const upserts = changes
      .filter((change) => change.action !== 'delete' && change.value)
      .sort((a, b) => {
        const ar = a.value!;
        const br = b.value!;
        const aw = ar.kind === 'folder' ? 0 : 1;
        const bw = br.kind === 'folder' ? 0 : 1;
        return aw - bw || ar.path.length - br.path.length;
      });

    for (const change of upserts) {
      const record = change.value!;
      const previous = change.oldValue ?? this.knownRecords.get(change.id);
      await this.applyRecord(record, previous);
      this.knownRecords.set(change.id, { ...record });
    }

    await this.plugin.refreshEditorBindings();
  }

  private async applyDeletedRecord(id: string, previous: FileRecord) {
    console.debug('[9sync] remote delete', previous.path);
    const local = this.plugin.app.vault.getAbstractFileByPath(previous.path);
    if (local) {
      this.markSuppressed(previous.path);
      await this.plugin.app.vault.delete(local, true).catch((error) => {
        console.error('[9sync] failed to delete local file', previous.path, error);
      });
    }
    this.sessions.get(id)?.destroy();
    this.sessions.delete(id);
    this.appliedHashes.delete(id);
  }

  private async applyRecord(record: FileRecord, previous?: FileRecord) {
    if (this.stopped) return;
    record = { ...record, path: normalizePath(record.path) };

    if (previous && normalizePath(previous.path) !== record.path) {
      const oldPath = normalizePath(previous.path);
      const oldLocal = this.plugin.app.vault.getAbstractFileByPath(oldPath);
      const newLocal = this.plugin.app.vault.getAbstractFileByPath(record.path);

      if (oldLocal && !newLocal) {
        console.debug('[9sync] remote rename', oldPath, '->', record.path);
        this.markSuppressed(oldPath);
        this.markSuppressed(record.path);
        await this.ensureParent(record.path);
        await this.plugin.app.vault.rename(oldLocal, record.path).catch((error) => {
          console.error('[9sync] failed to rename local file', oldPath, record.path, error);
        });
      }

      const session = this.sessions.get(record.id);
      if (session) session.path = record.path;
    }

    if (record.kind === 'folder') {
      if (!this.plugin.app.vault.getAbstractFileByPath(record.path)) {
        console.debug('[9sync] create folder', record.path);
        this.markSuppressed(record.path);
        await this.plugin.app.vault.createFolder(record.path).catch(() => undefined);
      }
      return;
    }

    if (record.kind === 'markdown') {
      const session = await this.ensureMarkdownSession(record);
      await session.ready;
      // Create/repair closed Markdown files immediately. Open notes are updated
      // in-memory through CodeMirror and must never be rewritten externally.
      await this.applyRemoteMarkdown(record.id, record.path, session.ytext.toString());
      return;
    }

    if (record.kind === 'attachment' && record.hash) {
      const local = this.plugin.app.vault.getAbstractFileByPath(record.path);
      if (!(local instanceof TFile) || this.appliedHashes.get(record.id) !== record.hash) {
        console.debug('[9sync] download attachment', record.path);
        await this.downloadAttachment(record);
        this.appliedHashes.set(record.id, record.hash);
      }
    }
  }

  private async fullReconcile() {
    if (this.stopped) return;
    const current = new Map(this.files.entries());

    const deleted = [...this.knownRecords.entries()]
      .filter(([id]) => !current.has(id))
      .sort((a, b) => b[1].path.length - a[1].path.length);
    for (const [id, previous] of deleted) await this.applyDeletedRecord(id, previous);

    const ordered = [...current.values()].sort((a, b) => {
      const aw = a.kind === 'folder' ? 0 : 1;
      const bw = b.kind === 'folder' ? 0 : 1;
      return aw - bw || a.path.length - b.path.length;
    });

    for (const record of ordered) {
      await this.applyRecord(record, this.knownRecords.get(record.id));
    }

    this.knownRecords = new Map([...current].map(([id, record]) => [id, { ...record }]));
    await this.plugin.refreshEditorBindings();
  }

  private async recoveryScan() {
    if (this.stopped || this.connectionStatus !== 'connected') return;

    const entries = this.plugin.app.vault.getAllLoadedFiles()
      .filter((file) => file.path && this.plugin.shouldSyncPath(file.path));
    const localByPath = new Map(entries.map((entry) => [normalizePath(entry.path), entry]));
    const records = [...this.files.values()];
    const missingRecords = records.filter((record) => !localByPath.has(normalizePath(record.path)));
    const unmatchedLocal = entries.filter((entry) => !this.findByPath(entry.path) && !this.isSuppressed(entry.path));

    // If another community plugin throws inside Obsidian's rename event loop,
    // our rename callback may never run. Recover the common folder-rename case
    // before full reconcile has a chance to recreate the old path.
    const missingFolders = missingRecords.filter((record) => record.kind === 'folder');
    const unmatchedFolders = unmatchedLocal.filter((entry): entry is TFolder => entry instanceof TFolder);
    if (missingFolders.length === 1 && unmatchedFolders.length === 1) {
      const oldPrefix = normalizePath(missingFolders[0].path);
      const newPrefix = normalizePath(unmatchedFolders[0].path);
      const updates: Array<[string, FileRecord]> = [];
      for (const [id, record] of this.files.entries()) {
        const path = normalizePath(record.path);
        if (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) {
          updates.push([id, {
            ...record,
            path: newPrefix + path.slice(oldPrefix.length),
            updatedAt: Date.now(),
          }]);
        }
      }
      if (updates.length > 0) {
        console.debug('[9sync] recovered missed folder rename', oldPrefix, '->', newPrefix);
        this.metaDoc.transact(() => updates.forEach(([id, record]) => this.files.set(id, record)), FILE_ORIGIN);
      }
    }

    // Recover missed file renames by matching the actual content. Markdown uses
    // its CRDT text; binary files use the published SHA-256 hash.
    for (const entry of unmatchedLocal) {
      if (!(entry instanceof TFile) || this.findByPath(entry.path)) continue;

      if (entry.extension.toLowerCase() === 'md') {
        const localText = await this.plugin.app.vault.read(entry);
        const candidates: FileRecord[] = [];
        for (const record of missingRecords) {
          if (record.kind !== 'markdown' || this.findByPath(entry.path)) continue;
          const session = await this.ensureMarkdownSession(record);
          await session.ready;
          if (session.ytext.toString() === localText) candidates.push(record);
        }
        if (candidates.length === 1) {
          const record = candidates[0];
          console.debug('[9sync] recovered missed markdown rename', record.path, '->', entry.path);
          this.files.set(record.id, { ...record, path: entry.path, updatedAt: Date.now() });
          continue;
        }
      } else {
        const data = await this.plugin.app.vault.readBinary(entry);
        const hash = await this.hash(data);
        const candidates = missingRecords.filter((record) => record.kind === 'attachment' && record.hash === hash);
        if (candidates.length === 1) {
          const record = candidates[0];
          console.debug('[9sync] recovered missed attachment rename', record.path, '->', entry.path);
          this.files.set(record.id, { ...record, path: entry.path, updatedAt: Date.now() });
          this.appliedHashes.set(record.id, hash);
          continue;
        }
      }
    }

    // Publish genuinely new local entries that were missed by the create event.
    for (const entry of entries) {
      if (this.stopped || this.isSuppressed(entry.path) || this.findByPath(entry.path)) continue;
      await this.onCreate(entry);
    }

    // Finally repair any remote record that is still missing locally.
    await this.enqueueMetaTask(() => this.fullReconcile());
  }

  private async downloadAttachment(record: FileRecord) {
    if (!record.hash) return;
    const response = await requestUrl({
      url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/workspaces/${encodeURIComponent(this.settings.workspaceId)}/blobs/${record.hash}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.settings.token}` },
      throw: false,
    });
    if (response.status !== 200) throw new Error(`Blob download failed: ${response.status}`);
    this.markSuppressed(record.path);
    await this.ensureParent(record.path);
    const existing = this.plugin.app.vault.getAbstractFileByPath(record.path);
    if (existing instanceof TFile) await this.plugin.app.vault.modifyBinary(existing, response.arrayBuffer);
    else await this.plugin.app.vault.createBinary(record.path, response.arrayBuffer);
  }

  private async uploadBlob(hash: string, data: ArrayBuffer) {
    const response = await requestUrl({
      url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/workspaces/${encodeURIComponent(this.settings.workspaceId)}/blobs/${hash}`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: data,
      throw: false,
    });
    if (![201, 204].includes(response.status)) throw new Error(`Blob upload failed: ${response.status}`);
  }

  private async ensureParent(target: string) {
    const parts = normalizePath(target).split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
        this.markSuppressed(current);
        await this.plugin.app.vault.createFolder(current).catch(() => undefined);
      }
    }
  }

  private async hash(data: ArrayBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  destroy() {
    this.stopped = true;
    if (this.recoveryTimer !== null) window.clearInterval(this.recoveryTimer);
    for (const timer of this.persistTimers.values()) window.clearTimeout(timer);
    this.persistTimers.clear();
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.metaProvider.destroy();
    this.metaDoc.destroy();
  }
}

export default class NineSyncPlugin extends Plugin {
  settings: NineSyncSettings = DEFAULT_SETTINGS;
  manager: SyncManager | null = null;

  private statusEl: HTMLElement | null = null;
  private boundEditors = new Map<EditorView, string>();
  private boundDocIds = new Set<string>();
  private bindingRefreshSeq = 0;

  async onload() {
    await this.loadSettings();
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }

    this.addSettingTab(new NineSyncSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('nine-sync-status');

    // A single lightweight CM6 extension handles per-keystroke text -> Y.Text
    // and cursor/selection presence. Remote Y.Text updates are dispatched back
    // into CodeMirror directly, so the visible editor never waits for disk I/O.
    this.registerEditorExtension([
      remoteCursorField,
      EditorView.updateListener.of((update) => this.handleEditorUpdate(update)),
    ]);

    this.addCommand({ id: 'restart-sync', name: 'Restart sync', callback: () => void this.restartSync() });
    this.addCommand({ id: 'version-history', name: 'Version history / Restore files', callback: () => this.openVersionHistory() });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && this.shouldSyncPath(file.path)) menu.addItem(item => item.setTitle('9sync: Version history').setIcon('history').onClick(() => this.openVersionHistory(file)));
    }));
    this.registerEvent(this.app.vault.on('create', (file) => void this.manager?.onCreate(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => void this.manager?.onModify(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.manager?.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => void this.manager?.onDelete(file)));
    this.registerEvent(this.app.workspace.on('file-open', () => void this.refreshEditorBindings()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => void this.refreshEditorBindings()));
    this.registerEvent(this.app.workspace.on('layout-change', () => void this.refreshEditorBindings()));

    this.app.workspace.onLayoutReady(() => void this.restartSync());
  }

  onunload() {
    this.detachVisibleEditors();
    this.manager?.destroy();
  }

  isDocumentBound(id: string) {
    return this.boundDocIds.has(id);
  }

  isPathOpen(path: string) {
    const normalized = normalizePath(path);
    return this.app.workspace.getLeavesOfType('markdown').some((leaf) => {
      return leaf.view instanceof MarkdownView
        && !!leaf.view.file
        && normalizePath(leaf.view.file.path) === normalized;
    });
  }

  private getCodeMirror(view: MarkdownView): EditorView | null {
    try {
      // Official Obsidian developer docs currently document this bridge.
      // @ts-expect-error Obsidian's public Editor type does not type cm.
      return view.editor.cm as EditorView;
    } catch {
      return null;
    }
  }

  private clearRemoteDecorations(cm: EditorView) {
    try {
      cm.dispatch({ effects: SET_REMOTE_CURSORS.of([]) });
    } catch {
      // The editor can already be destroyed while a leaf is closing.
    }
  }

  private detachEditor(cm: EditorView) {
    const id = this.boundEditors.get(cm);
    if (!id) return;
    this.clearRemoteDecorations(cm);
    this.boundEditors.delete(cm);
  }

  private detachVisibleEditors() {
    for (const [cm] of this.boundEditors) this.detachEditor(cm);
    for (const id of this.boundDocIds) this.manager?.clearLocalCursor(id);
    this.boundDocIds = new Set();
  }

  private handleEditorUpdate(update: ViewUpdate) {
    const id = this.boundEditors.get(update.view);
    const manager = this.manager;
    if (!id || !manager) return;

    const isRemote = update.transactions.some((transaction) => transaction.annotation(REMOTE_EDITOR_UPDATE) === true);

    if (update.docChanged && !isRemote) {
      const session = manager.sessions.get(id);
      if (session) {
        session.ydoc.transact(() => {
          let offset = 0;
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const from = fromA + offset;
            const deleteCount = toA - fromA;
            const insertText = inserted.toString();
            if (deleteCount > 0) session.ytext.delete(from, deleteCount);
            if (insertText.length > 0) session.ytext.insert(from, insertText);
            offset += insertText.length - deleteCount;
          });
        }, update.view);
      }
    }

    if (update.selectionSet || update.docChanged) {
      const main = update.state.selection.main;
      manager.updateLocalCursor(id, main.anchor, main.head);
    }
  }

  syncEditorsFromYDelta(
    id: string,
    delta: Array<{ retain?: number; insert?: string | object; delete?: number }>,
    finalText: string,
    origin: unknown,
  ) {
    const insertedLength = delta.reduce((sum, op) => sum + (typeof op.insert === 'string' ? op.insert.length : 0), 0);
    const deletedLength = delta.reduce((sum, op) => sum + (typeof op.delete === 'number' ? op.delete : 0), 0);
    const expectedOldLength = finalText.length - insertedLength + deletedLength;

    for (const [cm, boundId] of this.boundEditors) {
      if (boundId !== id || cm === origin) continue;

      try {
        // If this view somehow drifted (for example after plugin reload), repair it
        // once with the conservative full-text path before resuming delta sync.
        if (cm.state.doc.length !== expectedOldLength) {
          this.syncSingleEditorFromText(cm, finalText);
          continue;
        }

        const changes: Array<{ from: number; to?: number; insert?: string }> = [];
        let oldPos = 0;

        for (const op of delta) {
          if (typeof op.retain === 'number') {
            oldPos += op.retain;
          }
          if (typeof op.insert === 'string' && op.insert.length > 0) {
            const last = changes[changes.length - 1];
            if (last && last.from === oldPos && (last.to ?? last.from) === oldPos) {
              last.insert = (last.insert ?? '') + op.insert;
            } else {
              changes.push({ from: oldPos, insert: op.insert });
            }
          }
          if (typeof op.delete === 'number' && op.delete > 0) {
            const last = changes[changes.length - 1];
            if (last && last.from === oldPos && (last.to ?? last.from) === oldPos) {
              last.to = oldPos + op.delete;
            } else {
              changes.push({ from: oldPos, to: oldPos + op.delete });
            }
            oldPos += op.delete;
          }
        }

        if (changes.length === 0) continue;

        cm.dispatch({
          changes,
          annotations: [
            REMOTE_EDITOR_UPDATE.of(true),
            Transaction.addToHistory.of(false),
          ],
        });

        // Defensive check: never leave a visible editor diverged from the CRDT.
        // This fallback is not the normal path and should be rare.
        if (cm.state.doc.toString() !== finalText) {
          this.syncSingleEditorFromText(cm, finalText);
        }
      } catch (error) {
        console.error('[9sync] failed to apply realtime Yjs delta', error);
        this.syncSingleEditorFromText(cm, finalText);
      }
    }
  }

  private syncSingleEditorFromText(cm: EditorView, text: string) {
    try {
      const current = cm.state.doc.toString();
      if (current === text) return;

      let prefix = 0;
      const maxPrefix = Math.min(current.length, text.length);
      while (prefix < maxPrefix && current.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix += 1;

      let suffix = 0;
      while (
        suffix < current.length - prefix
        && suffix < text.length - prefix
        && current.charCodeAt(current.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)
      ) suffix += 1;

      cm.dispatch({
        changes: {
          from: prefix,
          to: current.length - suffix,
          insert: text.slice(prefix, text.length - suffix),
        },
        annotations: [
          REMOTE_EDITOR_UPDATE.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    } catch (error) {
      console.error('[9sync] failed to repair visible editor', error);
    }
  }

  syncEditorsFromYText(id: string, text: string) {
    for (const [cm, boundId] of this.boundEditors) {
      if (boundId !== id) continue;
      this.syncSingleEditorFromText(cm, text);
    }
  }

  renderRemoteCursors(id: string, cursors: RemoteCursorState[]) {
    for (const [cm, boundId] of this.boundEditors) {
      if (boundId !== id) continue;
      try {
        cm.dispatch({ effects: SET_REMOTE_CURSORS.of(cursors) });
      } catch {
        // Closing editor.
      }
    }
  }

  async refreshEditorBindings() {
    const seq = ++this.bindingRefreshSeq;
    const manager = this.manager;
    const nextBound = new Set<string>();
    const visibleEditors = new Set<EditorView>();

    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view;
      const cm = this.getCodeMirror(view);
      if (!cm) continue;
      visibleEditors.add(cm);

      const file = view.file;
      if (
        !manager ||
        !file ||
        file.extension.toLowerCase() !== 'md' ||
        !this.shouldSyncPath(file.path)
      ) {
        this.detachEditor(cm);
        continue;
      }

      const found = manager.findByPath(file.path);
      if (!found || found.record.kind !== 'markdown') {
        this.detachEditor(cm);
        continue;
      }

      const session = await manager.ensureMarkdownSession(found.record);
      await session.ready;
      if (seq !== this.bindingRefreshSeq || this.manager !== manager || view.file?.path !== file.path) continue;

      this.boundEditors.set(cm, found.id);
      nextBound.add(found.id);

      // Make the visible editor match Y.Text before sending cursor presence.
      this.syncEditorsFromYText(found.id, session.ytext.toString());
      const selection = cm.state.selection.main;
      manager.updateLocalCursor(found.id, selection.anchor, selection.head);
      this.renderRemoteCursors(found.id, session.remoteCursors());
    }

    // Prune stale EditorView references after leaves are closed/reused.
    for (const [cm] of [...this.boundEditors]) {
      if (!visibleEditors.has(cm)) this.detachEditor(cm);
    }

    if (seq === this.bindingRefreshSeq) {
      for (const oldId of this.boundDocIds) {
        if (!nextBound.has(oldId)) {
          manager?.clearLocalCursor(oldId);
          // Once the last visible editor closes, make sure the physical file is
          // caught up with the CRDT without ever touching it while it was open.
          void manager?.persistMarkdownIfClosed(oldId);
        }
      }
      this.boundDocIds = nextBound;
    }
  }

  shouldSyncPath(path: string) {
    const normalized = normalizePath(path);
    if (!normalized) return false;

    for (const excluded of parsePathList(this.settings.excludedPaths)) {
      if (normalized === excluded || normalized.startsWith(`${excluded}/`)) return false;
    }

    if (this.settings.syncMode === 'folder') {
      return isInside(this.settings.sharedFolder || 'Shared', normalized);
    }
    return true;
  }

  private attachmentTargetFolder(file: TFile) {
    const ext = file.extension.toLowerCase();
    const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic']);
    const media = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'mp4', 'mov', 'mkv', 'webm', 'avi']);

    if (images.has(ext)) return normalizePath(this.settings.imageFolder || 'Assets/Images');
    if (ext === 'pdf') return normalizePath(this.settings.pdfFolder || 'Assets/PDF');
    if (media.has(ext)) return normalizePath(this.settings.mediaFolder || 'Assets/Media');
    return normalizePath(this.settings.otherFileFolder || 'Assets/Files');
  }

  private async uniqueAttachmentPath(folder: string, file: TFile) {
    const cleanFolder = normalizePath(folder).replace(/\/$/, '');
    const ext = file.extension ? `.${file.extension}` : '';
    const base = file.basename;
    let candidate = cleanFolder ? `${cleanFolder}/${file.name}` : file.name;
    let index = 1;
    while (true) {
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing || existing === file) return candidate;
      candidate = cleanFolder ? `${cleanFolder}/${base}-${index}${ext}` : `${base}-${index}${ext}`;
      index += 1;
    }
  }

  async routeAttachment(file: TFile, manager?: SyncManager) {
    const ext = file.extension.toLowerCase();
    if (!this.settings.organizeAttachments || ['md', 'canvas', 'base'].includes(ext)) return file;

    const targetFolder = this.attachmentTargetFolder(file);
    if (!targetFolder || !this.shouldSyncPath(targetFolder)) return file;
    if (parentFolder(file.path) === targetFolder) return file;

    const targetPath = await this.uniqueAttachmentPath(targetFolder, file);
    const oldPath = file.path;
    if (normalizePath(oldPath) === normalizePath(targetPath)) return file;

    const parts = targetFolder.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        manager?.suppressPath(current);
        await this.app.vault.createFolder(current).catch(() => undefined);
      }
    }

    // Suppress the internal rename event because the caller publishes the final
    // path immediately after this move. FileManager is used (instead of raw
    // filesystem rename) so Obsidian can update links according to its settings.
    manager?.suppressPath(oldPath);
    manager?.suppressPath(targetPath);
    try {
      await this.app.fileManager.renameFile(file, targetPath);
      console.debug('[9sync] routed attachment', oldPath, '->', targetPath);
      return file;
    } catch (error) {
      console.error('[9sync] failed to route attachment', oldPath, targetPath, error);
      return file;
    }
  }

  async restartSync() {
    this.detachVisibleEditors();
    this.manager?.destroy();
    this.manager = null;

    if (!this.settings.workspaceId || !this.settings.token || !this.settings.serverUrl) {
      this.setStatus('9sync: not configured', false);
      return;
    }

    if (this.settings.syncMode === 'folder') {
      const folder = normalizePath(this.settings.sharedFolder || 'Shared');
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder).catch(() => undefined);
      }
    }

    this.manager = new SyncManager(this);
    this.setStatus('9sync: connecting…', false);
    await this.refreshEditorBindings();
  }

  setStatus(text: string, good: boolean) {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass('nine-sync-good', good);
    this.statusEl.toggleClass('nine-sync-bad', !good);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async createWorkspace() {
    const response = await requestUrl({
      url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/workspaces`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ name: this.settings.workspaceName }),
    });
    this.settings.workspaceId = response.json.id;
    this.settings.token = response.json.token;
    this.settings.inviteCode = response.json.inviteCode;
    await this.saveSettings();
    await this.restartSync();
    new Notice(`9sync workspace created. Invite: ${response.json.inviteCode}`);
  }

  openVersionHistory(file = this.app.workspace.getActiveFile()) {
    if (!this.settings.workspaceId || !this.settings.token) { new Notice('Connect to a 9sync Workspace first');return; }
    const fileId = file ? this.manager?.findByPath(file.path)?.id : undefined;
    new VersionHistoryModal(this.app, this.settings, fileId).open();
  }

  async joinWorkspace() {
    const response = await requestUrl({
      url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/join`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ inviteCode: this.settings.inviteCode }),
    });
    this.settings.workspaceId = response.json.id;
    this.settings.token = response.json.token;
    await this.saveSettings();
    await this.restartSync();
    new Notice(`Joined ${response.json.name}`);
  }
}

class NineSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NineSyncPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '9sync' });
    containerEl.createEl('p', {
      text: 'Markdown, live cursors, and the whole vault can sync through Yjs + SHA-256 blobs. New attachments can also be routed automatically into folders you choose.',
      cls: 'nine-sync-help',
    });

    new Setting(containerEl)
      .setName('Server URL')
      .addText((text) => text.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
        this.plugin.settings.serverUrl = v.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('User name')
      .setDesc('Shown beside your live cursor to collaborators.')
      .addText((text) => text.setValue(this.plugin.settings.userName).onChange(async (v) => {
        this.plugin.settings.userName = v.trim() || 'Anonymous';
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Sync scope')
      .setDesc('Entire vault syncs everything except excluded paths. Folder mode keeps the older single-folder behavior.')
      .addDropdown((dropdown) => dropdown
        .addOption('vault', 'Entire vault')
        .addOption('folder', 'Selected folder')
        .setValue(this.plugin.settings.syncMode)
        .onChange(async (value) => {
          this.plugin.settings.syncMode = value as 'vault' | 'folder';
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.syncMode === 'folder') {
      new Setting(containerEl)
        .setName('Shared folder')
        .setDesc('Only this folder is synchronized in Selected folder mode.')
        .addText((text) => text.setValue(this.plugin.settings.sharedFolder).onChange(async (v) => {
          this.plugin.settings.sharedFolder = normalizePath(v || 'Shared');
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl)
      .setName('Excluded paths')
      .setDesc('One path per line or comma-separated. These paths are never uploaded. Keep .obsidian excluded unless you deliberately want device settings/plugins to sync.')
      .addTextArea((text) => text
        .setValue(this.plugin.settings.excludedPaths)
        .setPlaceholder('.obsidian\n.trash\n.git\n.9sync')
        .onChange(async (v) => {
          this.plugin.settings.excludedPaths = v;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Attachment routing' });
    new Setting(containerEl).setName('Version history').setDesc('Browse snapshots, save checkpoints, compare versions and restore files, including deleted files. Requires an updated 9sync server.').addButton(button => button.setButtonText('Open history').onClick(() => this.plugin.openVersionHistory()));

    new Setting(containerEl)
      .setName('Organize attachments automatically')
      .setDesc('New images, PDFs, media, and other files are moved into the folders below before being synced.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.organizeAttachments).onChange(async (v) => {
        this.plugin.settings.organizeAttachments = v;
        await this.plugin.saveSettings();
        this.display();
      }));

    if (this.plugin.settings.organizeAttachments) {
      new Setting(containerEl)
        .setName('Images folder')
        .addText((text) => text.setValue(this.plugin.settings.imageFolder).onChange(async (v) => {
          this.plugin.settings.imageFolder = normalizePath(v || 'Assets/Images');
          await this.plugin.saveSettings();
        }));

      new Setting(containerEl)
        .setName('PDF folder')
        .addText((text) => text.setValue(this.plugin.settings.pdfFolder).onChange(async (v) => {
          this.plugin.settings.pdfFolder = normalizePath(v || 'Assets/PDF');
          await this.plugin.saveSettings();
        }));

      new Setting(containerEl)
        .setName('Audio / video folder')
        .addText((text) => text.setValue(this.plugin.settings.mediaFolder).onChange(async (v) => {
          this.plugin.settings.mediaFolder = normalizePath(v || 'Assets/Media');
          await this.plugin.saveSettings();
        }));

      new Setting(containerEl)
        .setName('Other files folder')
        .addText((text) => text.setValue(this.plugin.settings.otherFileFolder).onChange(async (v) => {
          this.plugin.settings.otherFileFolder = normalizePath(v || 'Assets/Files');
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl)
      .setName('Workspace name')
      .addText((text) => text.setValue(this.plugin.settings.workspaceName).onChange(async (v) => {
        this.plugin.settings.workspaceName = v;
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText('Create').setCta().onClick(async () => {
        try {
          await this.plugin.createWorkspace();
          this.display();
        } catch (e) {
          new Notice(`Create failed: ${String(e)}`);
        }
      }));

    new Setting(containerEl)
      .setName('Invite code')
      .addText((text) => text.setValue(this.plugin.settings.inviteCode).onChange(async (v) => {
        this.plugin.settings.inviteCode = v.trim().toUpperCase();
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText('Join').onClick(async () => {
        try {
          await this.plugin.joinWorkspace();
          this.display();
        } catch (e) {
          new Notice(`Join failed: ${String(e)}`);
        }
      }));

    new Setting(containerEl)
      .setName('Workspace ID')
      .setDesc(this.plugin.settings.workspaceId || 'Not connected to a workspace yet.');

    new Setting(containerEl)
      .setName('Restart')
      .setDesc('Reconnect after changing server, user name, sync scope, excludes, or attachment folders.')
      .addButton((button) => button.setButtonText('Restart sync').onClick(async () => {
        await this.plugin.restartSync();
        new Notice('9sync restarted');
      }));

    containerEl.createEl('p', {
      text: 'For testing, disable Relay in the same vault. Relay also bundles Yjs and can trigger the “Yjs was already imported” warning.',
      cls: 'nine-sync-help',
    });
  }
}

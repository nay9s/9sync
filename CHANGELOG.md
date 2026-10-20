# Changelog

## 0.5.0
- Add durable per-file version snapshots for Markdown and attachments, with stable IDs across moves and deletion.
- Add automatic snapshots, named checkpoints, bounded line diffs, historical downloads, and restore with pre-restore preservation and conflict checks.
- Add version history in the Obsidian command palette, file context menu, plugin settings, and admin console.
- Restore through live Yjs documents so connected collaborators receive changes; recreate missing parent folders and reject occupied paths.
- Initialize a baseline for existing server documents; preserve history until the Workspace is deleted.
- Validate with PostgreSQL-compatible PGlite, HTTP API integration tests, and restore propagation over real Yjs WebSockets to two clients.

## 0.4.0
- Added whole-vault sync with configurable excludes.
- Added automatic attachment routing for images, PDFs, media, and other files.
- Added duplicate-safe attachment names and Obsidian FileManager moves for link-aware renames.
- Kept selected-folder mode for backwards compatibility.
- Canvas/Base files stay in place while still syncing.

## 0.3.1

- Prevented open Markdown notes from being rewritten with `vault.modify()`, eliminating Obsidian external-merge cursor jumps.
- Ignored disk `modify` snapshots for open notes so stale autosave content cannot be pushed back into Yjs and delete freshly typed text.
- Switched live remote rendering to granular Y.Text delta -> CodeMirror changes, while retaining a conservative repair fallback for drift.
- Kept closed-note disk persistence and event-driven attachment/file sync from 0.3.0.
- Plugin-only compatibility update; no server/database migration required.

## 0.3.0

- Replaced delayed `vault.modify()`-driven realtime display with direct CodeMirror transaction ↔ Yjs synchronization.
- Added custom live collaborator cursor and selection rendering via Yjs Awareness.
- Removed `y-codemirror.next` dependency to simplify the editor path and reduce duplicate Yjs dependency risk inside 9sync itself.
- Reworked metadata sync into a serialized event-driven queue so overlapping Y.Map updates are not dropped.
- Create/rename/move/delete operations are applied immediately from metadata changes.
- Added 2.5 s recovery scan for file events swallowed by other community plugins.
- Recovery can infer missed Markdown renames from Yjs text and attachment renames from SHA-256.
- Added folder-rename recovery for unambiguous single-folder cases.
- Increased suppression handling to cover folder subtrees and delayed file events.
- Pinned `@codemirror/state` to 6.5.0 for Obsidian 1.13.x compatibility.
- Added `tslib` dependency.
- Server/API version bumped to 0.3.0; database schema remains compatible with 0.2.1.

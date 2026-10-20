declare module '@y/websocket-server/utils' {
  import type * as Y from 'yjs';
  export const docs: Map<string, Y.Doc>;
  export function getYDoc(name: string): Y.Doc;
  export function setupWSConnection(conn: unknown, req: unknown, options?: { docName?: string; gc?: boolean }): void;
  export function setPersistence(persistence: {
    bindState: (docName: string, ydoc: Y.Doc) => Promise<void> | void;
    writeState: (docName: string, ydoc: Y.Doc) => Promise<void> | void;
  }): void;
}

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Store } from './database.js';
import type { IncomingMessage } from 'node:http';
import type { DeploymentGate } from './deployment.js';

const MAX_PAYLOAD = 8 * 1024 * 1024;
interface Peer {
  ids: Set<number>;
  alive: boolean;
  bytes: number;
  window: number;
}
interface Room {
  doc: Y.Doc;
  awareness: Awareness;
  peers: Map<WebSocket, Peer>;
  boardId: string;
  writes: number;
  failed?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export class SyncServer {
  rooms = new Map<string, Room>();
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  heartbeat: ReturnType<typeof setInterval>;
  constructor(
    server: Server,
    private store: Store,
    authorize: (req: IncomingMessage, boardId: string, key?: string) => boolean,
    originAllowed: (req: IncomingMessage) => boolean,
    private deployment?: DeploymentGate,
  ) {
    server.on('upgrade', (req, socket, head) => {
      if (deployment?.paused) {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const match = url.pathname.match(/^\/sync\/([\w-]+)\/([\w-]+)$/);
      const page = match && store.page(match[2]);
      if (
        !match ||
        !page ||
        page.boardId !== match[1] ||
        !originAllowed(req) ||
        !authorize(req, match[1], url.searchParams.get('key') || undefined)
      ) {
        this.wss.handleUpgrade(req, socket, head, (ws) =>
          ws.close(4403, 'Board unavailable or access revoked'),
        );
        return;
      }
      if (this.wss.clients.size >= 200 || (this.rooms.size >= 100 && !this.rooms.has(page.id))) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, page.id, page.boardId));
    });
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values())
        for (const [ws, peer] of room.peers) {
          if (!peer.alive) {
            ws.terminate();
            continue;
          }
          peer.alive = false;
          ws.ping();
        }
    }, 20000);
    this.heartbeat.unref();
  }
  private send(ws: WebSocket, data: Uint8Array) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_PAYLOAD * 2) {
      ws.close(1013, 'Client too slow; reconnect');
      return;
    }
    ws.send(data);
  }
  private broadcast(room: Room, data: Uint8Array) {
    for (const ws of room.peers.keys()) this.send(ws, data);
  }
  private room(pageId: string, boardId: string) {
    let room = this.rooms.get(pageId);
    if (room) {
      if (room.failed) throw new Error('Room recovering after sync failure');
      clearTimeout(room.timer);
      return room;
    }
    const doc = this.store.loadDocument(pageId);
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    room = { doc, awareness, peers: new Map(), boardId, writes: 0 };
    this.rooms.set(pageId, room);
    const active = room;
    doc.on('update', (update: Uint8Array) => {
      // This listener persists synchronously BEFORE any broadcast or acknowledgement.
      this.store.appendUpdate(pageId, update);
      if (++active.writes % 200 === 0) this.store.compact(pageId, doc);
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 0);
      sync.writeUpdate(out, update);
      this.broadcast(active, encoding.toUint8Array(out));
    });
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: WebSocket | null,
      ) => {
        const peer = origin && active.peers.get(origin);
        if (peer) {
          added.forEach((id) => peer.ids.add(id));
          removed.forEach((id) => peer.ids.delete(id));
        }
        const out = encoding.createEncoder();
        encoding.writeVarUint(out, 1);
        encoding.writeVarUint8Array(
          out,
          encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
        );
        this.broadcast(active, encoding.toUint8Array(out));
      },
    );
    return room;
  }
  private connect(ws: WebSocket, pageId: string, boardId: string) {
    let room: Room;
    try {
      room = this.room(pageId, boardId);
    } catch {
      ws.close(1011, 'Storage unavailable');
      return;
    }
    const peer: Peer = { ids: new Set(), alive: true, bytes: 0, window: Date.now() };
    room.peers.set(ws, peer);
    this.deployment?.connected();
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      const data = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      try {
        if (!isBinary) {
          ws.close(4400, 'Binary messages required');
          return;
        }
        if (Date.now() - peer.window > 10000) {
          peer.bytes = 0;
          peer.window = Date.now();
        }
        peer.bytes += data.length;
        if (peer.bytes > 32 * 1024 * 1024) {
          ws.close(4429, 'Rate limit exceeded');
          return;
        }
        const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
        const type = decoding.readVarUint(decoder);
        const out = encoding.createEncoder();
        if (type === 0) {
          encoding.writeVarUint(out, 0);
          // Do not use readSyncMessage: it catches storage exceptions inside readUpdate.
          const subtype = decoding.readVarUint(decoder);
          if (subtype === 0) sync.readSyncStep1(decoder, out, room.doc);
          else if (subtype === 1 || subtype === 2)
            Y.applyUpdate(room.doc, decoding.readVarUint8Array(decoder), ws);
          else throw new Error('Unknown sync message');
          if (encoding.length(out) > 1) this.send(ws, encoding.toUint8Array(out));
        } else if (type === 1) {
          if (data.length > 16384) {
            ws.close(4400, 'Presence too large');
            return;
          }
          applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        } else if (type === 3) {
          encoding.writeVarUint(out, 1);
          encoding.writeVarUint8Array(
            out,
            encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
          );
          this.send(ws, encoding.toUint8Array(out));
        } else if (type === 4) {
          // Ordered barrier: all prior messages on this socket have reached SQLite.
          encoding.writeVarUint(out, 4);
          encoding.writeVarUint(out, decoding.readVarUint(decoder));
          this.send(ws, encoding.toUint8Array(out));
        } else ws.close(4400, 'Unknown message');
      } catch (error) {
        room.failed = true;
        console.error('Sync failure:', error instanceof Error ? error.message : 'unknown');
        // Fail closed. No acknowledgement; clients keep their IndexedDB copies.
        for (const client of room.peers.keys()) client.close(1011, 'Synchronization failed');
      }
    });
    ws.on('close', () => {
      room.peers.delete(ws);
      this.deployment?.disconnected();
      removeAwarenessStates(room.awareness, [...peer.ids], null);
      if (room.peers.size === 0) {
        room.timer = setTimeout(() => this.evict(pageId), 2000);
        room.timer.unref();
      }
    });
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, 0);
    sync.writeSyncStep1(out, room.doc);
    this.send(ws, encoding.toUint8Array(out));
    if (room.awareness.getStates().size) {
      const presence = encoding.createEncoder();
      encoding.writeVarUint(presence, 1);
      encoding.writeVarUint8Array(
        presence,
        encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
      );
      this.send(ws, encoding.toUint8Array(presence));
    }
  }
  private evict(pageId: string) {
    const room = this.rooms.get(pageId);
    if (!room || room.peers.size) return;
    clearTimeout(room.timer);
    try {
      if (!room.failed) this.store.compact(pageId, room.doc);
    } catch (e) {
      console.error('Compaction failed; update log retained', e);
    }
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(pageId);
  }
  revoke(boardId: string, pageId?: string) {
    for (const [id, room] of this.rooms)
      if (room.boardId === boardId && (!pageId || id === pageId))
        for (const ws of room.peers.keys()) ws.close(4403, 'Access changed; reload');
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) for (const ws of room.peers.keys()) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    for (const id of this.rooms.keys()) this.evict(id);
  }
}

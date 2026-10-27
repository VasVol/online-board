import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { boardKey } from '../api';
import { isBoardEvent, type BoardEvent, type GridState } from '../../shared/board-controls';
export type ConnectionState = 'loading' | 'saved' | 'saving' | 'offline' | 'denied';
export class PageSession {
  doc = new Y.Doc();
  local: IndexeddbPersistence;
  provider: WebsocketProvider;
  private counter = 0;
  lastAck = -1;
  lastBarrier = -1;
  private destroyed = false;
  private initialSync = false;
  private offline = () => {
    this.provider.disconnect();
    this.status('offline');
  };
  private online = () => {
    if (this.state !== 'denied') this.provider.connect();
  };
  private state: ConnectionState = 'loading';
  private timer?: ReturnType<typeof setTimeout>;
  onStatus: (state: ConnectionState) => void = () => {};
  onBoardEvent: (event: BoardEvent) => void = () => {};
  grid: GridState | null = null;
  constructor(boardId: string, pageId: string) {
    this.local = new IndexeddbPersistence(`pole:v1:${boardId}:${pageId}`, this.doc);
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.provider = new WebsocketProvider(
      `${protocol}://${location.host}/sync/${boardId}`,
      pageId,
      this.doc,
      { connect: false, disableBc: true, params: { key: boardKey(boardId) } },
    );
    this.provider.messageHandlers[5] = (_encoder, decoder) => {
      const event: unknown = JSON.parse(decoding.readVarString(decoder));
      if (!isBoardEvent(event)) return;
      if (event.type === 'grid') this.grid = event;
      this.onBoardEvent(event);
    };
    this.provider.messageHandlers[4] = (_encoder, decoder) => {
      const ack = decoding.readVarUint(decoder);
      this.lastAck = ack;
      if (ack === this.counter && this.provider.synced) this.status('saved');
    };
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    this.provider.on('status', ({ status }: { status: string }) => {
      if (this.state === 'denied') return;
      if (status === 'disconnected') this.status('offline');
      else if (status === 'connected') this.status('saving');
    });
    this.provider.on('connection-close', (event: CloseEvent | null) => {
      if (event && event.code >= 4400 && event.code < 4500) this.status('denied');
    });
    this.provider.on('sync', (synced: boolean) => {
      if (synced) {
        this.initialSync = true;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.barrier(), 0);
      }
    });
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === this.provider) return;
      this.counter++;
      if (this.state !== 'denied')
        this.status(
          this.provider.wsconnected ? 'saving' : this.initialSync ? 'offline' : 'loading',
        );
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.barrier(), 60);
    });
  }
  private status(state: ConnectionState) {
    if (this.destroyed) return;
    this.state = state;
    this.onStatus(state);
  }
  private barrier() {
    if (this.provider.ws?.readyState === WebSocket.OPEN && this.provider.synced) {
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 4);
      encoding.writeVarUint(out, this.counter);
      this.lastBarrier = this.counter;
      this.provider.ws.send(encoding.toUint8Array(out));
    }
  }
  async start() {
    await this.local.whenSynced;
    if (!this.destroyed) this.provider.connect();
  }
  async destroy() {
    this.destroyed = true;
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    clearTimeout(this.timer);
    this.provider.destroy();
    await this.local.destroy();
    this.doc.destroy();
  }
}

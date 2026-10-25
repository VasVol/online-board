import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import { request, json } from '../api';

// Images are stored outside the CRDT. A local IndexedDB copy keeps uploads available
// during network outages; other clients fetch only images on the current page.
function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pole-files-v1', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cached(key: string, value?: BinaryFileData): Promise<BinaryFileData | undefined> {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', value ? 'readwrite' : 'readonly');
    const op = value ? tx.objectStore('files').put(value, key) : tx.objectStore('files').get(key);
    tx.oncomplete = () => {
      db.close();
      resolve(value || op.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export class FileBridge {
  private pending = new Map<string, BinaryFileData>();
  private uploaded = new Set<string>();
  private loaded = new Set<string>();
  private busy = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private boardId: string,
    private api: ExcalidrawImperativeAPI,
    private error: (text: string) => void,
    private onPending: (pending: boolean) => void,
  ) {
    this.timer = setInterval(() => {
      void this.upload();
      void this.load();
    }, 3000);
  }
  accept(files: BinaryFiles) {
    for (const file of Object.values(files))
      if (!this.uploaded.has(file.id) && !this.pending.has(file.id)) {
        if (
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimeType) ||
          file.dataURL.length > 2800000
        ) {
          this.uploaded.add(file.id);
          this.error('Изображение не сохранено: используйте PNG, JPEG, WebP или GIF до 2 МБ.');
          continue;
        }
        this.pending.set(file.id, file);
        void cached(`${this.boardId}:${file.id}`, file).catch(() =>
          this.error('Не удалось сохранить изображение в браузере'),
        );
      }
    this.onPending(this.pending.size > 0);
    void this.upload();
  }
  private async upload() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const [id, file] of this.pending) {
        await request(`/boards/${this.boardId}/files/${id}`, json('PUT', file));
        this.pending.delete(id);
        this.uploaded.add(id);
      }
    } catch {
      this.error(
        'Изображение ожидает загрузки. Оставьте страницу открытой до восстановления связи.',
      );
    } finally {
      this.busy = false;
      if (!this.stopped) this.onPending(this.pending.size > 0);
    }
  }
  async load() {
    const ids = this.api
      .getSceneElements()
      .flatMap((e) =>
        e.type === 'image' &&
        e.fileId &&
        !this.api.getFiles()[e.fileId] &&
        !this.loaded.has(e.fileId)
          ? [e.fileId]
          : [],
      );
    for (const id of new Set(ids)) {
      this.loaded.add(id);
      try {
        let file = await cached(`${this.boardId}:${id}`);
        if (file) {
          this.pending.set(id, file);
          void this.upload();
        } else {
          file = await request<BinaryFileData>(`/boards/${this.boardId}/files/${id}`);
          this.uploaded.add(id);
          void cached(`${this.boardId}:${id}`, file).catch(() => {});
        }
        if (!this.stopped) this.api.addFiles([file]);
      } catch {
        this.loaded.delete(id);
      }
    }
  }
  get hasPending() {
    return this.pending.size > 0;
  }
  destroy() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}

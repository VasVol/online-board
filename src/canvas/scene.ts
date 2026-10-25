import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export const LOCAL_EDIT = Symbol('local-scene-edit');
export const revision = (element: ExcalidrawElement) =>
  `${element.version}:${element.versionNonce}:${element.isDeleted}`;
export function readElements(map: Y.Map<ExcalidrawElement>): ExcalidrawElement[] {
  return [...map.values()]
    .filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.type === 'string' &&
        Number.isFinite(e.x) &&
        Number.isFinite(e.y),
    )
    .sort((a, b) =>
      String(a.index || '') < String(b.index || '')
        ? -1
        : String(a.index || '') > String(b.index || '')
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
}
/** Each shape is a CRDT entry. Never replace the whole scene or delete absent keys.
 * Deletions are Excalidraw tombstones: they are required for undo and offline merging.
 */
export class SceneBinding {
  private baseline = new Map<string, string>();
  readonly elements: Y.Map<ExcalidrawElement>;
  constructor(
    private doc: Y.Doc,
    private render: (elements: ExcalidrawElement[]) => void,
  ) {
    this.elements = doc.getMap('elements');
    this.remember(readElements(this.elements));
    this.elements.observe(this.remote);
  }
  acceptRemote(elements: readonly ExcalidrawElement[]) {
    this.remember(elements);
  }
  private remember(elements: readonly ExcalidrawElement[]) {
    this.baseline = new Map(elements.map((e) => [e.id, revision(e)]));
  }
  private remote = (event: Y.YMapEvent<ExcalidrawElement>) => {
    if (event.transaction.origin === LOCAL_EDIT) return;
    const elements = readElements(this.elements);
    this.render(elements);
  };
  publish(elements: readonly ExcalidrawElement[]) {
    let stale = false;
    this.doc.transact(() => {
      for (const element of elements) {
        const rev = revision(element);
        if (this.baseline.get(element.id) === rev) continue;
        const current = this.elements.get(element.id);
        if (current && revision(current) === rev) continue;
        // An onChange queued before a remote render must not overwrite a newer shape.
        if (current && element.version < current.version) {
          stale = true;
          continue;
        }
        this.elements.set(element.id, JSON.parse(JSON.stringify(element)) as ExcalidrawElement);
      }
    }, LOCAL_EDIT);
    this.remember(elements);
    if (stale) {
      const merged = readElements(this.elements);
      this.render(merged);
    }
  }
  destroy() {
    this.elements.unobserve(this.remote);
  }
}

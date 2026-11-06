import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** A local hit-testing projection for one eraser gesture, never a saved image lock.
 * Keep revisions unchanged: this is not an edit and must not enter SDK history.
 * Detach groups/frames too: the SDK otherwise erases their children implicitly.
 */
export function installImageEraserGuard(root: HTMLElement, api: ExcalidrawImperativeAPI) {
  const originals = new Map<string, ExcalidrawElement>();
  const normalize = (elements: readonly ExcalidrawElement[]) => {
    if (!originals.size) return elements;
    return elements.map((element) => {
      const original = originals.get(element.id);
      return original
        ? {
            ...element,
            locked: original.locked,
            groupIds: original.groupIds,
            frameId: original.frameId,
          }
        : element;
    });
  };
  const restore = () => {
    if (!originals.size) return;
    const elements = normalize(api.getSceneElementsIncludingDeleted());
    originals.clear();
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  };
  const down = (event: PointerEvent) => {
    if (
      !(event.target instanceof HTMLCanvasElement) ||
      api.getAppState().viewModeEnabled ||
      !(
        event.button === 5 ||
        (event.button === 0 && api.getAppState().activeTool.type === 'eraser')
      )
    )
      return;
    restore();
    const elements = api.getSceneElementsIncludingDeleted().map((element) => {
      if (element.type !== 'image' || element.isDeleted) return element;
      originals.set(element.id, element);
      return { ...element, locked: true, groupIds: [], frameId: null };
    });
    if (originals.size)
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  };
  // The SDK finishes erasing in its window pointerup listener. Restore after that
  // entire event, before Canvas's animation-frame flush / queued remote render.
  const up = () => queueMicrotask(restore);
  root.addEventListener('pointerdown', down, true);
  const unsubscribe = api.onPointerUp(up);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  return {
    normalize,
    destroy() {
      restore();
      root.removeEventListener('pointerdown', down, true);
      unsubscribe();
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    },
  };
}

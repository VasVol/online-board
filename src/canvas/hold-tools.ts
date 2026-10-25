import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState } from '@excalidraw/excalidraw/types';
import { circleBounds, isTextTarget, type Point } from './geometry';
export interface Preview {
  type: 'line' | 'ellipse';
  start: Point;
  end: Point;
  color: string;
  width: number;
  dash: string;
  opacity: number;
}
export function installHoldTools(
  root: HTMLElement,
  api: ExcalidrawImperativeAPI,
  preview: (value: Preview | null) => void,
) {
  const held = new Set<string>();
  let previous: AppState['activeTool'] | null = null;
  let gesture: {
    start: Point;
    clientStart: Point;
    type: 'line' | 'ellipse';
    pointerId: number;
  } | null = null;
  function restore() {
    if (!held.size && !gesture && previous) {
      api.setActiveTool(previous);
      previous = null;
      preview(null);
    }
  }
  const down = (e: KeyboardEvent) => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      isTextTarget(e.target) ||
      api.getAppState().editingTextElement ||
      !['KeyL', 'KeyC'].includes(e.code)
    )
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (!previous) previous = api.getAppState().activeTool;
    held.add(e.code);
    api.setActiveTool({ type: e.code === 'KeyL' ? 'line' : 'ellipse', locked: true });
  };
  const up = (e: KeyboardEvent) => {
    if (!held.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    held.delete(e.code);
    if (held.size && !gesture)
      api.setActiveTool({ type: [...held].at(-1) === 'KeyL' ? 'line' : 'ellipse', locked: true });
    restore();
  };
  const pointerDown = (e: PointerEvent) => {
    if (!held.size || e.button !== 0 || !(e.target instanceof HTMLCanvasElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    gesture = {
      start: viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        api.getAppState(),
      ),
      clientStart: { x: e.clientX, y: e.clientY },
      type: [...held].at(-1) === 'KeyL' ? 'line' : 'ellipse',
      pointerId: e.pointerId,
    };
    root.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e: PointerEvent) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const state = api.getAppState(),
      rect = root.getBoundingClientRect();
    preview({
      type: gesture.type,
      start: { x: gesture.clientStart.x - rect.left, y: gesture.clientStart.y - rect.top },
      end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      color: state.currentItemStrokeColor,
      width: state.currentItemStrokeWidth * state.zoom.value,
      dash:
        state.currentItemStrokeStyle === 'dashed'
          ? '8 6'
          : state.currentItemStrokeStyle === 'dotted'
            ? '2 5'
            : '',
      opacity: state.currentItemOpacity / 100,
    });
  };
  const pointerUp = (e: PointerEvent) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const state = api.getAppState();
    const end = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, state);
    const { start, type } = gesture;
    if (Math.hypot(end.x - start.x, end.y - start.y) > 1) {
      const style = {
        strokeColor: state.currentItemStrokeColor,
        strokeWidth: state.currentItemStrokeWidth,
        strokeStyle: state.currentItemStrokeStyle,
        roughness: 0,
        opacity: state.currentItemOpacity,
        backgroundColor: 'transparent',
      };
      const elements = convertToExcalidrawElements(
        type === 'line'
          ? [
              {
                type: 'line',
                x: start.x,
                y: start.y,
                points: [
                  [0, 0],
                  [end.x - start.x, end.y - start.y],
                ],
                ...style,
              },
            ]
          : [{ type: 'ellipse', ...circleBounds(start, end), ...style }],
      );
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
    root.releasePointerCapture(e.pointerId);
    gesture = null;
    preview(null);
    restore();
  };
  const cancel = () => {
    held.clear();
    gesture = null;
    preview(null);
    restore();
  };
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  root.addEventListener('pointerdown', pointerDown, true);
  window.addEventListener('pointermove', pointerMove, true);
  window.addEventListener('pointerup', pointerUp, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('pointercancel', cancel);
  return () => {
    cancel();
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
    root.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('pointermove', pointerMove, true);
    window.removeEventListener('pointerup', pointerUp, true);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('pointercancel', cancel);
  };
}

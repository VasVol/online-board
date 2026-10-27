import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
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
export function installDrawingTools(
  root: HTMLElement,
  api: ExcalidrawImperativeAPI,
  preview: (value: Preview | null) => void,
) {
  let gesture: {
    start: Point;
    clientStart: Point;
    type: 'line' | 'ellipse';
    pointerId: number;
  } | null = null;
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
    api.setActiveTool({
      type: 'custom',
      customType: e.code === 'KeyL' ? 'straight' : 'circle',
      locked: true,
    });
  };
  const pointerDown = (e: PointerEvent) => {
    const state = api.getAppState();
    const tool = state.activeTool;
    if (
      state.viewModeEnabled ||
      tool.type !== 'custom' ||
      !['straight', 'circle'].includes(tool.customType ?? '') ||
      e.button !== 0 ||
      !(e.target instanceof HTMLCanvasElement)
    )
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    gesture = {
      start: viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        api.getAppState(),
      ),
      clientStart: { x: e.clientX, y: e.clientY },
      type: tool.customType === 'straight' ? 'line' : 'ellipse',
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
  };
  const cancel = () => {
    if (gesture && root.hasPointerCapture(gesture.pointerId))
      root.releasePointerCapture(gesture.pointerId);
    gesture = null;
    preview(null);
  };
  const unsubscribe = api.onChange(() => {
    if (gesture) {
      const tool = api.getAppState().activeTool;
      if (
        tool.type !== 'custom' ||
        tool.customType !== (gesture.type === 'line' ? 'straight' : 'circle')
      )
        cancel();
    }
  });
  window.addEventListener('keydown', down, true);
  root.addEventListener('pointerdown', pointerDown, true);
  window.addEventListener('pointermove', pointerMove, true);
  window.addEventListener('pointerup', pointerUp, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('pointercancel', cancel);
  return () => {
    unsubscribe();
    cancel();
    window.removeEventListener('keydown', down, true);
    root.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('pointermove', pointerMove, true);
    window.removeEventListener('pointerup', pointerUp, true);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('pointercancel', cancel);
  };
}

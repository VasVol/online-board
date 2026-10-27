import type { AppState } from '@excalidraw/excalidraw/types';
import type { Viewport } from '../../shared/board-controls';
export function readViewport(state: AppState): Viewport {
  return {
    x: state.width / (2 * state.zoom.value) - state.scrollX,
    y: state.height / (2 * state.zoom.value) - state.scrollY,
    zoom: state.zoom.value,
  };
}
export function applyViewport(state: AppState, viewport: Viewport) {
  return {
    scrollX: state.width / (2 * viewport.zoom) - viewport.x,
    scrollY: state.height / (2 * viewport.zoom) - viewport.y,
    zoom: { value: viewport.zoom as AppState['zoom']['value'] },
  };
}

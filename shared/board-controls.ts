export type Viewport = { x: number; y: number; zoom: number };
export type GridState = { enabled: boolean; revision: number };
export type GatherCommand = {
  type: 'gather';
  id: string;
  source: string;
  pageId: string;
  viewport: Viewport;
};
export type BoardEvent = ({ type: 'grid' } & GridState) | GatherCommand;
export function isViewport(value: unknown): value is Viewport {
  const v = value as Viewport | undefined;
  return (
    !!v &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.zoom) &&
    v.zoom >= 0.1 &&
    v.zoom <= 30
  );
}
export function isBoardEvent(value: unknown): value is BoardEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as BoardEvent;
  if (v.type === 'grid')
    return typeof v.enabled === 'boolean' && Number.isSafeInteger(v.revision) && v.revision >= 0;
  return (
    v.type === 'gather' &&
    typeof v.id === 'string' &&
    typeof v.source === 'string' &&
    typeof v.pageId === 'string' &&
    /^[\w-]{1,64}$/.test(v.pageId) &&
    isViewport(v.viewport)
  );
}

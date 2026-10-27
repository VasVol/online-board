// Ephemeral scene coordinates only: never publish laser strokes to the Y.Doc.
export const LASER_IDLE_MS = 1000;
export const LASER_FADE_MS = 600;
export type LaserPoint = { x: number; y: number };
type Pointer = LaserPoint & { tool?: string };
type Trail = {
  strokes: LaserPoint[][];
  current?: LaserPoint[];
  last?: LaserPoint;
  down: boolean;
  updated: number;
};

export class LaserTrails {
  readonly trails = new Map<number, Trail>();

  update(id: number, pointer: Pointer | undefined, button: unknown, now: number) {
    let trail = this.trails.get(id);
    const valid =
      pointer?.tool === 'laser' && Number.isFinite(pointer.x) && Number.isFinite(pointer.y);
    const down = valid && button === 'down';
    if (!trail) {
      if (!down) return;
      trail = { strokes: [], down: false, updated: now };
      this.trails.set(id, trail);
    }
    this.expire(trail, now);
    const moved = valid && (pointer.x !== trail.last?.x || pointer.y !== trail.last?.y);
    // Include the final pointer-up coordinate, but ignore idle awareness heartbeats.
    if (valid && ((down && (!trail.down || moved)) || (trail.down && moved))) {
      if (!trail.current) {
        trail.current = [];
        trail.strokes.push(trail.current);
      }
      const point = { x: pointer.x, y: pointer.y };
      trail.current.push(point);
      trail.last = point;
      trail.updated = now;
    }
    trail.down = down;
    if (!down) trail.current = undefined;
  }

  opacity(trail: Trail, now: number) {
    this.expire(trail, now);
    return Math.max(0, Math.min(1, 1 - (now - trail.updated - LASER_IDLE_MS) / LASER_FADE_MS));
  }

  private expire(trail: Trail, now: number) {
    if (now - trail.updated >= LASER_IDLE_MS + LASER_FADE_MS) {
      trail.strokes = [];
      trail.current = undefined;
    }
  }
}

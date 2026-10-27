import { DEFAULT_LASER_COLOR } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { LaserTrails } from './laser';

// Uses public pointer callbacks and awareness, independently of the SDK's fading
// trail renderer. Each participant has their own inactivity clock.
export class LaserOverlay {
  private readonly model = new LaserTrails();
  private readonly canvas = document.createElement('canvas');
  private frame = 0;

  constructor(
    private root: HTMLElement,
    private api: ExcalidrawImperativeAPI,
  ) {
    this.canvas.className = 'laser-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(this.canvas);
  }

  update(
    id: number,
    pointer: { x: number; y: number; tool?: string } | undefined,
    button: unknown,
  ) {
    this.model.update(id, pointer, button, performance.now());
    if (!this.frame && this.model.trails.size) this.frame = requestAnimationFrame(this.draw);
  }

  retain(ids: Set<number>) {
    for (const id of this.model.trails.keys()) {
      if (!ids.has(id)) this.model.trails.delete(id);
    }
  }

  private draw = (now: number) => {
    this.frame = 0;
    const rect = this.root.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio),
      height = Math.round(rect.height * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const state = this.api.getAppState();
    const zoom = state.zoom.value;
    ctx.translate(state.offsetLeft - rect.left, state.offsetTop - rect.top);
    ctx.scale(zoom, zoom);
    ctx.translate(state.scrollX, state.scrollY);
    ctx.strokeStyle = ctx.fillStyle = DEFAULT_LASER_COLOR;
    ctx.lineWidth = 4 / zoom;
    ctx.lineCap = ctx.lineJoin = 'round';
    let visible = false;
    for (const trail of this.model.trails.values()) {
      ctx.globalAlpha = this.model.opacity(trail, now);
      if (!trail.strokes.length) continue;
      visible = true;
      ctx.beginPath();
      for (const stroke of trail.strokes) {
        ctx.moveTo(stroke[0].x, stroke[0].y);
        // A click without movement is a visible dot too.
        if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.01 / zoom, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      ctx.stroke();
    }
    if (visible) this.frame = requestAnimationFrame(this.draw);
  };

  destroy() {
    cancelAnimationFrame(this.frame);
    this.model.trails.clear();
    this.canvas.remove();
  }
}

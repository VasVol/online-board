import { useEffect, useState } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Awareness } from 'y-protocols/awareness';

type Cursor = {
  id: number;
  x: number;
  y: number;
  name: string;
  color: string;
  down: boolean;
  outside: boolean;
};
export function RemoteCursors({
  api,
  awareness,
  names,
}: {
  api: ExcalidrawImperativeAPI;
  awareness: Awareness;
  names: boolean;
}) {
  const [cursors, setCursors] = useState<Cursor[]>([]);
  useEffect(() => {
    let frame = 0;
    const render = () => {
      frame = 0;
      const state = api.getAppState();
      const next: Cursor[] = [];
      for (const [id, value] of awareness.getStates()) {
        const p = value.pointer;
        if (id === awareness.clientID || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
          continue;
        const x = (p.x + state.scrollX) * state.zoom.value;
        const y = (p.y + state.scrollY) * state.zoom.value;
        next.push({
          id,
          x: Math.max(0, Math.min(state.width - 14, x)),
          y: Math.max(0, Math.min(state.height - 18, y)),
          outside: x < 0 || y < 0 || x > state.width - 14 || y > state.height - 18,
          name: typeof value.name === 'string' ? value.name.slice(0, 40) : 'Участник',
          color: `hsl(${((id * 137.508) % 360).toFixed(3)}, 65%, 40%)`,
          down: value.button === 'down',
        });
      }
      setCursors(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    const unsubscribe = api.onChange(schedule);
    awareness.on('change', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      awareness.off('change', schedule);
    };
  }, [api, awareness]);
  return (
    <div className="remote-cursors" aria-hidden="true">
      {cursors.map((cursor) => (
        <div
          key={cursor.id}
          className="remote-cursor"
          data-client={cursor.id}
          style={{
            transform: `translate(${cursor.x}px, ${cursor.y}px)`,
            color: cursor.color,
            opacity: cursor.outside ? 0.35 : 1,
          }}
        >
          <svg width="18" height="22" viewBox="-3 -3 18 22">
            {cursor.down && (
              <circle cx="0" cy="0" r="10" fill="none" stroke="currentColor" opacity="0.5" />
            )}
            <path
              d="M0 0 L0 14 L4 9 L11 8 Z"
              fill="currentColor"
              stroke="white"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          {names && !cursor.outside && (
            <span className="remote-cursor-name" style={{ background: cursor.color }}>
              {cursor.name}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

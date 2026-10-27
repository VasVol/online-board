import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardEvent, GatherCommand, GridState, Viewport } from '../shared/board-controls';
import type { Page } from '../shared/types';
import { request, json } from './api';

export function useBoardControls(
  boardId: string,
  selectPage: (page: Page) => void,
  onError: (text: string) => void,
) {
  const [grid, setGrid] = useState<GridState>({ enabled: false, revision: -1 });
  const [gridBusy, setGridBusy] = useState(false);
  const [gatherBusy, setGatherBusy] = useState(false);
  const [target, setTarget] = useState<GatherCommand | null>(null);
  const source = useRef(crypto.randomUUID());
  const camera = useRef<(() => Viewport) | null>(null);
  const received = useRef<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const acceptGrid = useCallback(
    (next: GridState) =>
      setGrid((previous) => (next.revision > previous.revision ? next : previous)),
    [],
  );
  const targetApplied = useCallback(
    (id: string) => setTarget((previous) => (previous?.id === id ? null : previous)),
    [],
  );
  const cameraReady = useCallback((read: (() => Viewport) | null) => {
    camera.current = read;
  }, []);
  const onEvent = useCallback(
    (event: BoardEvent) => {
      if (event.type === 'grid') {
        acceptGrid(event);
        return;
      }
      if (event.source === source.current || received.current === event.id) return;
      received.current = event.id;
      void request<Page>(`/boards/${boardId}/pages/${event.pageId}`)
        .then((page) => {
          if (!active.current || received.current !== event.id) return;
          setTarget(event);
          selectPage(page);
        })
        .catch((error) => {
          if (active.current) onError(error.message);
        });
    },
    [boardId, selectPage, onError, acceptGrid],
  );
  async function toggleGrid() {
    if (gridBusy) return;
    setGridBusy(true);
    try {
      acceptGrid(
        await request<GridState>(
          `/boards/${boardId}/grid`,
          json('PATCH', { enabled: !grid.enabled }),
        ),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось изменить сетку');
    } finally {
      if (active.current) setGridBusy(false);
    }
  }
  async function gather(pageId: string) {
    if (!camera.current || gatherBusy) return;
    setGatherBusy(true);
    try {
      await request(
        `/boards/${boardId}/gather`,
        json('POST', { pageId, source: source.current, viewport: camera.current() }),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось собрать участников');
    } finally {
      if (active.current) setGatherBusy(false);
    }
  }
  return {
    grid,
    gridBusy,
    gatherBusy,
    target,
    acceptGrid,
    onEvent,
    cameraReady,
    targetApplied,
    toggleGrid,
    gather,
  };
}

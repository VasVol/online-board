import { useEffect, useRef, useState } from 'react';
import {
  Excalidraw,
  MainMenu,
  CaptureUpdateAction,
  restoreElements,
  newElementWith,
  convertToExcalidrawElements,
  serializeAsJSON,
  exportToBlob,
  DEFAULT_LASER_COLOR,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  Collaborator,
  SocketId,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import {
  Pencil,
  Highlighter,
  MousePointer2,
  Hand,
  Eraser,
  Download,
  Maximize,
  Grid2X2,
  ImagePlus,
  Images,
  Tags,
  Minus,
  Circle,
} from 'lucide-react';
import { PageSession, type ConnectionState } from './session';
import { SceneBinding, readElements } from './scene';
import { FileBridge } from './files';
import { insertImage } from './insert-image';
import { ImageLibrary } from './ImageLibrary';
import { installDrawingTools, type Preview } from './drawing-tools';
import { readViewport, applyViewport } from './viewport';
import type { BoardEvent, GatherCommand, Viewport } from '../../shared/board-controls';
import { circleBounds } from './geometry';
import { LaserOverlay } from './laser-overlay';
import { RemoteCursors } from './RemoteCursors';
import { installFollowing } from './follow';
import { download } from '../api';

type Props = {
  boardId: string;
  pageId: string;
  name: string;
  username: string;
  onStatus: (state: ConnectionState) => void;
  onPeople: (names: string[]) => void;
  onError: (error: string) => void;
  grid: boolean;
  gridBusy: boolean;
  onToggleGrid: () => void;
  onBoardEvent: (event: BoardEvent) => void;
  onCameraReady: (read: (() => Viewport) | null) => void;
  cameraTarget: GatherCommand | null;
  onCameraApplied: (id: string) => void;
};
type PenStyle = 'solid' | 'marker' | 'dashed' | 'dotted';
export default function Canvas(props: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [session, setSession] = useState<PageSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tool, setTool] = useState('freedraw');
  const [connection, setConnection] = useState<ConnectionState>('loading');
  const connectionRef = useRef<ConnectionState>('loading');
  const imagePending = useRef(false);
  const laser = useRef<LaserOverlay | null>(null);
  const [penStyle, setPenStyle] = useState<PenStyle>('solid');
  const [color, setColor] = useState('#28354a');
  const [width, setWidth] = useState(2);
  const [cursorNames, setCursorNames] = useState(false);
  const [library, setLibrary] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const binding = useRef<SceneBinding | null>(null),
    files = useRef<FileBridge | null>(null);
  const pending = useRef<readonly ExcalidrawElement[] | null>(null),
    timer = useRef<ReturnType<typeof setTimeout>>();
  const handlers = useRef(props);
  handlers.current = props;
  const penRef = useRef(penStyle);
  penRef.current = penStyle;
  const gestureIds = useRef(new Set<string>());
  useEffect(() => {
    const current = new PageSession(props.boardId, props.pageId);
    current.onStatus = (state) => {
      connectionRef.current = state;
      setConnection(state);
      handlers.current.onStatus(state === 'saved' && imagePending.current ? 'saving' : state);
    };
    current.onBoardEvent = (event) => handlers.current.onBoardEvent(event);
    let disposed = false;
    void current
      .start()
      .then(() => {
        if (!disposed) setSession(current);
      })
      .catch(() =>
        handlers.current.onError(
          'Не удалось открыть локальное хранилище браузера. Проверьте свободное место.',
        ),
      );
    return () => {
      disposed = true;
      queueMicrotask(() => void current.destroy());
    };
  }, [props.boardId, props.pageId]);
  useEffect(() => {
    if (!session || !api || !root.current) return;
    let raf = 0;
    let interacting = false;
    let remoteQueued = false;
    const apply = (elements: ExcalidrawElement[]) => {
      remoteQueued = true;
      if (interacting) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (interacting) return;
        remoteQueued = false;
        // Flush queued local edits before applying the latest CRDT state.
        flush();
        const restored = restoreElements(readElements(session.doc.getMap('elements')), null);
        binding.current?.acceptRemote(restored);
        api.updateScene({ elements: restored, captureUpdate: CaptureUpdateAction.NEVER });
        void files.current?.load();
      });
    };
    files.current = new FileBridge(
      props.boardId,
      api,
      (text) => handlers.current.onError(text),
      (pending) => {
        imagePending.current = pending;
        handlers.current.onStatus(
          connectionRef.current === 'saved' && pending ? 'saving' : connectionRef.current,
        );
      },
    );
    binding.current = new SceneBinding(session.doc, apply);
    const initial = restoreElements(readElements(binding.current.elements), null);
    binding.current.acceptRemote(initial);
    api.updateScene({ elements: initial, captureUpdate: CaptureUpdateAction.NEVER });
    api.history.clear();
    const awareness = session.provider.awareness;
    laser.current = new LaserOverlay(root.current, api);
    const presence = () => {
      const collaborators = new Map<SocketId, Collaborator>();
      const names: string[] = [];
      laser.current?.retain(new Set(awareness.getStates().keys()));
      for (const [id, value] of awareness.getStates()) {
        if (id === session.doc.clientID) continue;
        const name = typeof value.name === 'string' ? value.name.slice(0, 40) : 'Участник';
        names.push(name);
        const pointer = value.pointer;
        laser.current?.update(id, pointer, value.button);
        collaborators.set(String(id) as SocketId, {
          username: name,
          ...(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
            ? {
                pointer: {
                  x: pointer.x,
                  y: pointer.y,
                  tool: pointer.tool === 'laser' ? ('laser' as const) : ('pointer' as const),
                  laserColor: DEFAULT_LASER_COLOR,
                  renderCursor: false,
                },
              }
            : {
                // The SDK captures the first pointer when choosing the trail color.
                // Hide the cursor until a real position arrives, but seed its color.
                pointer: {
                  x: 0,
                  y: 0,
                  tool: 'pointer' as const,
                  renderCursor: false,
                  laserColor: DEFAULT_LASER_COLOR,
                },
              }),
          button: value.button === 'down' ? 'down' : 'up',
          color: { background: '#d8eee7', stroke: '#16836a' },
        });
      }
      api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
      handlers.current.onPeople(names);
    };
    awareness.on('change', presence);
    awareness.setLocalStateField('name', props.username);
    presence();
    const removeFollowing = installFollowing(api, awareness);
    const removeTools = installDrawingTools(root.current, api, setPreview);
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof HTMLCanvasElement && event.button === 0) {
        interacting = true;
        gestureIds.current = new Set(api.getSceneElements().map((e) => e.id));
      }
    };
    root.current.addEventListener('pointerdown', pointerDown, true);
    const pointerUp = () => {
      if (!interacting) return;
      requestAnimationFrame(() => {
        interacting = false;
        // Excalidraw's freedraw renderer does not support dashed contours.
        // Convert only a completed dashed pen stroke to a continuous curve (same id).
        if (penRef.current === 'dashed' || penRef.current === 'dotted') {
          const elements = api.getSceneElementsIncludingDeleted();
          let changed = false;
          const next = elements.map((e) => {
            if (e.type !== 'freedraw' || gestureIds.current.has(e.id) || e.isDeleted) return e;
            changed = true;
            const [line] = convertToExcalidrawElements(
              [
                {
                  ...e,
                  type: 'line',
                  strokeStyle: penRef.current === 'dotted' ? 'dotted' : 'dashed',
                  // A continuous curve keeps the dash phase across pointer samples.
                  // A sharp polyline restarts it on every tiny segment and looks solid.
                  roundness: { type: 2 },
                },
              ],
              { regenerateIds: false },
            );
            return { ...line, index: e.index, version: e.version + 1 };
          });
          if (changed)
            api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          flush();
        } else flush();
        if (remoteQueued) apply([]);
      });
    };
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (files.current?.hasPending || connectionRef.current !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    if (import.meta.env.VITE_E2E === 'true')
      (window as unknown as { __board: unknown }).__board = { api, session, flush };
    return () => {
      flush();
      cancelAnimationFrame(raf);
      removeTools();
      removeFollowing();
      laser.current?.destroy();
      laser.current = null;
      root.current?.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
      window.removeEventListener('beforeunload', beforeUnload);
      awareness.off('change', presence);
      binding.current?.destroy();
      binding.current = null;
      files.current?.destroy();
      files.current = null;
    };
  }, [api, session]);
  useEffect(() => {
    session?.provider.awareness.setLocalStateField('name', props.username);
  }, [session, props.username]);
  useEffect(() => {
    if (!api) return;
    handlers.current.onCameraReady(() => readViewport(api.getAppState()));
    return () => handlers.current.onCameraReady(null);
  }, [api]);
  useEffect(() => {
    const target = props.cameraTarget;
    if (!api || !session || !target || target.pageId !== props.pageId) return;
    flush();
    api.updateScene({
      appState: { ...applyViewport(api.getAppState(), target.viewport), userToFollow: null },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    handlers.current.onCameraApplied(target.id);
  }, [api, session, props.cameraTarget, props.pageId]);
  function flush() {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current && binding.current) {
      const value = pending.current;
      pending.current = null;
      binding.current.publish(value);
    }
  }
  function change(elements: readonly ExcalidrawElement[], state: AppState, binary: BinaryFiles) {
    const nextTool =
      state.activeTool.type === 'custom'
        ? (state.activeTool.customType ?? 'custom')
        : state.activeTool.type;
    setTool((previous) => (previous === nextTool ? previous : nextTool));
    if (!binding.current) return;
    pending.current = elements;
    if (!timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined;
        flush();
      }, 40);
    files.current?.accept(binary);
  }
  function chooseTool(type: 'freedraw' | 'selection' | 'hand' | 'eraser' | 'straight' | 'circle') {
    if (type === 'straight' || type === 'circle')
      api?.setActiveTool({ type: 'custom', customType: type, locked: true });
    else api?.setActiveTool({ type, locked: true });
  }
  function style(nextColor: string, nextWidth: number, nextStyle: PenStyle) {
    setColor(nextColor);
    setWidth(nextWidth);
    setPenStyle(nextStyle);
    const strokeStyle =
      nextStyle === 'dashed' ? 'dashed' : nextStyle === 'dotted' ? 'dotted' : 'solid';
    const opacity = nextStyle === 'marker' ? 35 : 100;
    const strokeWidth = nextStyle === 'marker' ? nextWidth * 5 : nextWidth;
    api?.updateScene({
      appState: {
        currentItemStrokeColor: nextColor,
        currentItemStrokeWidth: strokeWidth,
        currentItemStrokeStyle: strokeStyle,
        currentItemOpacity: opacity,
        currentItemRoughness: 0,
      },
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((e) =>
          api.getAppState().selectedElementIds[e.id]
            ? newElementWith(e, { strokeColor: nextColor, strokeWidth, strokeStyle, opacity })
            : e,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
  async function addImage(file: File, signal?: AbortSignal) {
    if (!api || !files.current) throw new Error('Подождите, пока откроется страница.');
    const bridge = files.current;
    await insertImage(file, api, (binary) => bridge.accept({ [binary.id]: binary }), signal);
  }
  async function uploadImage(file?: File) {
    if (!file) return;
    try {
      await addImage(file);
    } catch (error) {
      handlers.current.onError(
        error instanceof Error ? error.message : 'Не удалось загрузить изображение',
      );
    } finally {
      if (imageInput.current) imageInput.current.value = '';
    }
  }
  async function savePng() {
    if (!api) return;
    try {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        files: api.getFiles(),
        appState: { ...api.getAppState(), exportWithDarkMode: false },
        mimeType: 'image/png',
      });
      download(`${props.name}.png`, blob);
    } catch {
      handlers.current.onError('Не удалось экспортировать PNG');
    }
  }
  function saveJson() {
    if (api)
      download(
        `${props.name}.excalidraw`,
        serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
      );
  }
  const bounds = preview?.type === 'ellipse' ? circleBounds(preview.start, preview.end) : null;
  return (
    <div className="canvas-layout">
      <aside className="drawing-controls" aria-label="Инструменты рисования">
        <div className="tool-group">
          {(
            [
              { type: 'selection', label: 'Select — выделение (V)', icon: MousePointer2 },
              { type: 'hand', label: 'Hand — перемещение (H)', icon: Hand },
              { type: 'freedraw', label: 'Draw — карандаш (P)', icon: Pencil },
              { type: 'straight', label: 'Прямая (L)', icon: Minus },
              { type: 'circle', label: 'Окружность (C)', icon: Circle },
              { type: 'eraser', label: 'Eraser — ластик (E)', icon: Eraser },
            ] as const
          ).map(({ type, label, icon: Icon }) => (
            <button
              key={type}
              title={label}
              aria-label={label}
              aria-pressed={tool === type}
              className={tool === type ? 'selected' : ''}
              onClick={() => chooseTool(type)}
            >
              <Icon size={19} />
            </button>
          ))}
        </div>
        <span className="tool-divider" />
        <label className="color-control" title="Цвет пера">
          <input
            type="color"
            aria-label="Цвет пера"
            value={color}
            onChange={(e) => style(e.target.value, width, penStyle)}
          />
        </label>
        <label className="select-control">
          <span>Толщина</span>
          <select
            aria-label="Толщина пера"
            value={width}
            onChange={(e) => style(color, Number(e.target.value), penStyle)}
          >
            {[1, 2, 4, 6, 10].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </label>
        <label className="select-control">
          <span>Стиль</span>
          <select
            aria-label="Стиль пера"
            value={penStyle}
            onChange={(e) => style(color, width, e.target.value as PenStyle)}
          >
            <option value="solid">Перо</option>
            <option value="marker">Маркер</option>
            <option value="dashed">Пунктир</option>
            <option value="dotted">Точки</option>
          </select>
        </label>
        <span className="tool-divider" />
        <button
          aria-label="Добавить изображение"
          title="Добавить изображение"
          onClick={() => imageInput.current?.click()}
        >
          <ImagePlus size={18} />
        </button>
        <input
          type="file"
          data-testid="image-upload"
          ref={imageInput}
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => void uploadImage(e.target.files?.[0])}
        />
        <button
          className="image-library-toggle"
          aria-label="Библиотека картинок"
          title="Библиотека картинок"
          disabled={!api || !session || connection === 'denied'}
          onClick={() => setLibrary(true)}
        >
          <Images size={18} />
          Картинки
        </button>
        <button
          aria-label="Сетка"
          title="Сетка"
          aria-pressed={props.grid}
          onClick={props.onToggleGrid}
          disabled={
            props.gridBusy ||
            connection === 'offline' ||
            connection === 'loading' ||
            connection === 'denied'
          }
          className={props.grid ? 'selected' : ''}
        >
          <Grid2X2 size={18} />
        </button>
        <button
          aria-label="Показать всё"
          title="Показать всё"
          onClick={() => api?.scrollToContent(undefined, { fitToContent: true })}
        >
          <Maximize size={18} />
        </button>
        <button
          aria-label="Подписи курсоров"
          title="Подписи курсоров"
          aria-pressed={cursorNames}
          className={cursorNames ? 'selected' : ''}
          onClick={() => setCursorNames(!cursorNames)}
        >
          <Tags size={18} />
        </button>
        <div className="key-hints">
          <kbd>L</kbd> прямая <kbd>C</kbd> окружность <span>· нажмите для выбора</span>
        </div>
      </aside>
      {library && <ImageLibrary onInsert={addImage} onClose={() => setLibrary(false)} />}
      <div className="canvas" ref={root} data-testid="drawing-surface">
        {session ? (
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={{
              elements: restoreElements(readElements(session.doc.getMap('elements')), null),
              appState: {
                activeTool: {
                  type: 'freedraw',
                  locked: true,
                  lastActiveTool: null,
                  customType: null,
                },
                currentItemStrokeColor: '#28354a',
                currentItemStrokeWidth: 2,
                currentItemRoughness: 0,
                currentItemRoundness: 'sharp',
                viewBackgroundColor: '#ffffff',
              },
            }}
            onChange={change}
            langCode="ru-RU"
            viewModeEnabled={connection === 'denied'}
            handleKeyboardGlobally
            isCollaborating
            gridModeEnabled={props.grid}
            validateEmbeddable={false}
            onPointerUpdate={({ pointer, button }) => {
              const awareness = session.provider.awareness;
              laser.current?.update(session.doc.clientID, pointer, button);
              // Publish the tool, position and button in one ephemeral update.
              awareness.setLocalState({ ...awareness.getLocalState(), pointer, button });
            }}
            UIOptions={{
              canvasActions: { saveToActiveFile: false, export: false, loadScene: false },
            }}
          >
            <MainMenu>
              <MainMenu.Item icon={<Download size={16} />} onSelect={saveJson}>
                Скачать .excalidraw
              </MainMenu.Item>
              <MainMenu.Item icon={<Download size={16} />} onSelect={() => void savePng()}>
                Скачать PNG
              </MainMenu.Item>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.Help />
            </MainMenu>
          </Excalidraw>
        ) : (
          <div className="canvas-loading">Открываем страницу…</div>
        )}
        {api && session && (
          <RemoteCursors api={api} awareness={session.provider.awareness} names={cursorNames} />
        )}
        {preview && (
          <svg className="shape-preview" aria-hidden="true">
            <g
              fill="none"
              stroke={preview.color}
              strokeWidth={preview.width}
              strokeDasharray={preview.dash}
              opacity={preview.opacity}
            >
              {bounds ? (
                <ellipse
                  cx={bounds.x + bounds.width / 2}
                  cy={bounds.y + bounds.height / 2}
                  rx={bounds.width / 2}
                  ry={bounds.height / 2}
                />
              ) : (
                <line
                  x1={preview.start.x}
                  y1={preview.start.y}
                  x2={preview.end.x}
                  y2={preview.end.y}
                />
              )}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

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
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  Collaborator,
  SocketId,
  BinaryFileData,
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
} from 'lucide-react';
import { PageSession, type ConnectionState } from './session';
import { SceneBinding, readElements } from './scene';
import { FileBridge } from './files';
import { installHoldTools, type Preview } from './hold-tools';
import { circleBounds } from './geometry';
import { download } from '../api';

type Props = {
  boardId: string;
  pageId: string;
  name: string;
  username: string;
  onStatus: (state: ConnectionState) => void;
  onPeople: (names: string[]) => void;
  onError: (error: string) => void;
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
  const [penStyle, setPenStyle] = useState<PenStyle>('solid');
  const [color, setColor] = useState('#28354a');
  const [width, setWidth] = useState(2);
  const [grid, setGrid] = useState(false);
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
    const presence = () => {
      const collaborators = new Map<SocketId, Collaborator>();
      const names: string[] = [];
      for (const [id, value] of awareness.getStates()) {
        if (id === session.doc.clientID) continue;
        const name = typeof value.name === 'string' ? value.name.slice(0, 40) : 'Участник';
        names.push(name);
        const pointer = value.pointer;
        collaborators.set(String(id) as SocketId, {
          username: name,
          ...(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
            ? { pointer: { x: pointer.x, y: pointer.y, tool: 'pointer' as const } }
            : {}),
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
    const removeHold = installHoldTools(root.current, api, setPreview);
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
      removeHold();
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
    setTool((previous) => (previous === state.activeTool.type ? previous : state.activeTool.type));
    if (!binding.current) return;
    pending.current = elements;
    if (!timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined;
        flush();
      }, 40);
    files.current?.accept(binary);
  }
  function chooseTool(type: 'freedraw' | 'selection' | 'hand' | 'eraser') {
    api?.setActiveTool({ type, locked: true });
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
  async function insertImage(file?: File) {
    if (!file || !api) return;
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ||
        file.size > 2 * 1024 * 1024
      )
        throw new Error('Выберите PNG, JPEG, WebP или GIF размером до 2 МБ.');
      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      const id = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('') as BinaryFileData['id'];
      const binary: BinaryFileData = {
        id,
        dataURL: dataURL as BinaryFileData['dataURL'],
        mimeType: file.type as BinaryFileData['mimeType'],
        created: Date.now(),
      };
      const state = api.getAppState();
      const point = viewportCoordsToSceneCoords(
        {
          clientX: state.offsetLeft + state.width / 2,
          clientY: state.offsetTop + state.height / 2,
        },
        state,
      );
      const scale = Math.min(1, 600 / image.naturalWidth, 500 / image.naturalHeight);
      const width = image.naturalWidth * scale,
        height = image.naturalHeight * scale;
      api.addFiles([binary]);
      files.current?.accept({ [id]: binary });
      const elements = convertToExcalidrawElements([
        {
          type: 'image',
          fileId: id,
          x: point.x - width / 2,
          y: point.y - height / 2,
          width,
          height,
          status: 'saved',
          scale: [1, 1],
        },
      ]);
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.setActiveTool({ type: 'selection' });
    } catch (error) {
      handlers.current.onError(
        error instanceof Error ? error.message : 'Не удалось загрузить изображение',
      );
    }
    if (imageInput.current) imageInput.current.value = '';
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
          onChange={(e) => void insertImage(e.target.files?.[0])}
        />
        <button
          aria-label="Сетка"
          title="Сетка"
          aria-pressed={grid}
          onClick={() => setGrid(!grid)}
          className={grid ? 'selected' : ''}
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
        <div className="key-hints">
          <kbd>L</kbd> прямая <kbd>C</kbd> окружность <span>· удерживайте</span>
        </div>
      </aside>
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
                viewBackgroundColor: '#ffffff',
              },
            }}
            onChange={change}
            langCode="ru-RU"
            viewModeEnabled={connection === 'denied'}
            handleKeyboardGlobally
            isCollaborating
            gridModeEnabled={grid}
            validateEmbeddable={false}
            onPointerUpdate={({ pointer, button }) => {
              session.provider.awareness.setLocalStateField('pointer', pointer);
              session.provider.awareness.setLocalStateField('button', button);
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

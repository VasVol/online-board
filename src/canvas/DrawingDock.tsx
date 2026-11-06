import {
  MousePointer2,
  Hand,
  Pencil,
  Minus,
  Circle,
  Eraser,
  ScanLine,
  Images,
  Ellipsis,
  Maximize,
  Tags,
  Download,
  ImagePlus,
  Grid2X2,
  Shapes,
  HelpCircle,
} from 'lucide-react';
import { Popover } from '../components/Popover';

export const PALETTE = [
  ['Чёрный', '#1e1e1e'],
  ['Серый', '#9da6b2'],
  ['Сиреневый', '#df83f4'],
  ['Фиолетовый', '#b83bd1'],
  ['Синий', '#4465ed'],
  ['Голубой', '#4b9ded'],
  ['Жёлтый', '#f4ad46'],
  ['Оранжевый', '#e96913'],
  ['Зелёный', '#099b70'],
  ['Светло-зелёный', '#48b461'],
  ['Розовый', '#f36b82'],
  ['Красный', '#e03131'],
] as const;
export type DrawingTool =
  'selection' | 'hand' | 'freedraw' | 'straight' | 'circle' | 'eraser' | 'laser';
const tools = [
  { type: 'selection', label: 'Select — выделение (V)', icon: MousePointer2 },
  { type: 'hand', label: 'Hand — перемещение (H)', icon: Hand },
  { type: 'freedraw', label: 'Draw — карандаш (P)', icon: Pencil },
  { type: 'laser', label: 'Указка (K)', icon: ScanLine },
  { type: 'straight', label: 'Прямая (L)', icon: Minus },
  { type: 'circle', label: 'Окружность (C)', icon: Circle },
  { type: 'eraser', label: 'Eraser — ластик (E)', icon: Eraser },
] as const;
export function DrawingDock(props: {
  onHelp: () => void;
  advanced: boolean;
  onAdvanced: () => void;
  penStyle: 'solid' | 'marker' | 'dashed' | 'dotted';
  onStyle: (style: 'solid' | 'marker' | 'dashed' | 'dotted') => void;
  grid: boolean;
  gridDisabled: boolean;
  onGrid: () => void;
  tool: string;
  color: string;
  width: number;
  disabled: boolean;
  cursorNames: boolean;
  onTool: (tool: DrawingTool) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onLibrary: () => void;
  onFit: () => void;
  onCursorNames: () => void;
  onPng: () => void;
  onSvg: () => void;
  onJson: () => void;
  onUpload: () => void;
}) {
  return (
    <aside className="drawing-dock" aria-label="Инструменты рисования">
      <div className="dock-tools">
        {tools.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            title={label}
            aria-label={label}
            aria-pressed={props.tool === type}
            disabled={props.disabled}
            onClick={() => props.onTool(type)}
          >
            <Icon size={19} />
          </button>
        ))}
        <button
          title="Картинки"
          aria-label="Библиотека картинок"
          disabled={props.disabled}
          onClick={props.onLibrary}
        >
          <Images size={19} />
        </button>
      </div>
      <div className="dock-palette" role="group" aria-label="Цвет пера">
        {PALETTE.map(([label, color]) => (
          <button
            key={color}
            title={label}
            aria-label={`Цвет: ${label}`}
            aria-pressed={props.color === color}
            disabled={props.disabled}
            onClick={() => props.onColor(color)}
          >
            <span style={{ background: color }} />
          </button>
        ))}
      </div>
      <Popover label="Ещё" trigger={<Ellipsis size={19} />} className="dock-more">
        <button aria-pressed={props.advanced} onClick={props.onAdvanced}>
          <Shapes size={16} />
          Все инструменты
        </button>
        <label className="extra-setting">
          Стиль
          <select
            aria-label="Стиль пера"
            value={props.penStyle}
            onChange={(e) => props.onStyle(e.target.value as typeof props.penStyle)}
          >
            <option value="solid">Перо</option>
            <option value="marker">Маркер</option>
            <option value="dashed">Пунктир</option>
            <option value="dotted">Точки</option>
          </select>
        </label>
        <label className="extra-setting">
          Толщина
          <select
            aria-label="Толщина пера"
            value={props.width}
            onChange={(e) => props.onWidth(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </label>
        <button aria-pressed={props.grid} disabled={props.gridDisabled} onClick={props.onGrid}>
          <Grid2X2 size={16} />
          Сетка
        </button>
        <button onClick={props.onFit}>
          <Maximize size={16} />
          Показать всё
        </button>
        <button aria-pressed={props.cursorNames} onClick={props.onCursorNames}>
          <Tags size={16} />
          Подписи курсоров
        </button>
        <div className="popover-separator" />
        <button onClick={props.onPng}>
          <Download size={16} />
          Скачать PNG
        </button>
        <button onClick={props.onSvg}>
          <Download size={16} />
          Скачать SVG
        </button>
        <button onClick={props.onJson}>
          <Download size={16} />
          Скачать .excalidraw
        </button>
        <button onClick={props.onUpload}>
          <ImagePlus size={16} />
          Добавить изображение
        </button>
        <div className="popover-separator" />
        <button onClick={props.onHelp}>
          <HelpCircle size={16} />
          Инструменты и клавиши
        </button>
      </Popover>
    </aside>
  );
}

import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  ArrowLeft,
  Search,
  Layers3,
  Pencil,
  Trash2,
  Link2,
  X,
  Check,
  HelpCircle,
  Users,
  Copy,
  LockKeyhole,
} from 'lucide-react';
import type { Page, PageList, BoardDetails } from '../shared/types';
import type { ConnectionState } from './canvas/session';
import { request, json, boardKey } from './api';
import { useBoardControls } from './useBoardControls';
import { Logo, Dialog, NameDialog, Pager, message } from './components/ui';
const Canvas = lazy(() => import('./canvas/Canvas'));
export default function Workspace({ id }: { id: string }) {
  const [details, setDetails] = useState<BoardDetails | null>(null),
    [pages, setPages] = useState<PageList<Page> | null>(null),
    [current, setCurrent] = useState<Page | null>(null);
  const [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState('');
  const [status, setStatus] = useState<ConnectionState>('loading'),
    [people, setPeople] = useState<string[]>([]);
  const [edit, setEdit] = useState<'board' | 'page' | 'new' | null>(null),
    [share, setShare] = useState(''),
    [copied, setCopied] = useState(false),
    [help, setHelp] = useState(false),
    [deleting, setDeleting] = useState(false),
    [rotating, setRotating] = useState(false);
  const [username, setUsername] = useState(() => localStorage.getItem('pole-name') || 'Участник');
  const [nameEdit, setNameEdit] = useState(false),
    [sidebar, setSidebar] = useState(true);
  const currentRef = useRef(current);
  currentRef.current = current;
  const selectPage = useCallback((page: Page) => {
    if (currentRef.current?.id === page.id) return;
    currentRef.current = page;
    setCurrent(page);
    setStatus('loading');
    setPeople([]);
    const url = new URL(location.href);
    url.searchParams.set('page', page.id);
    history.replaceState(null, '', url);
  }, []);
  const controls = useBoardControls(id, selectPage, setError);
  const load = useCallback(async () => {
    const [board, list] = await Promise.all([
      request<BoardDetails>(`/boards/${id}`),
      request<PageList<Page>>(
        `/boards/${id}/pages?q=${encodeURIComponent(query)}&limit=50&offset=${offset}`,
      ),
    ]);
    setDetails(board);
    controls.acceptGrid({ enabled: board.board.gridEnabled, revision: board.board.gridRevision });
    setPages(list);
    if (!currentRef.current) {
      const requested = new URL(location.href).searchParams.get('page');
      const first = requested
        ? await request<Page>(`/boards/${id}/pages/${requested}`).catch(() => list.items[0])
        : list.items[0];
      if (first) selectPage(first);
    } else {
      const page = list.items.find((p) => p.id === currentRef.current?.id);
      if (page) setCurrent(page);
    }
  }, [id, query, offset, selectPage, controls.acceptGrid]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) void load().catch((e) => setError(message(e)));
    };
    const initial = setTimeout(refresh, 120);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 5000);
    return () => {
      active = false;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [load]);
  async function shareBoard() {
    try {
      const key = details?.isOwner
        ? (await request<{ key: string }>(`/boards/${id}/share`)).key
        : boardKey(id);
      const url = new URL(`/b/${id}`, location.origin);
      url.hash = `key=${key}`;
      setShare(url.href);
      setCopied(false);
    } catch (e) {
      setError(message(e));
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(share);
      setCopied(true);
    } catch {
      setError('Выделите ссылку в окне и скопируйте её вручную.');
    }
  }
  async function saveName(name: string) {
    if (edit === 'board') {
      await request(`/boards/${id}`, json('PATCH', { name }));
      await load();
    } else if (edit === 'page' && current) {
      await request(`/boards/${id}/pages/${current.id}`, json('PATCH', { name }));
      await load();
    } else {
      const page = await request<Page>(`/boards/${id}/pages`, json('POST', { name }));
      setQuery('');
      setOffset(Math.floor((pages?.total || 0) / 50) * 50);
      selectPage(page);
      await load();
    }
  }
  const states: Record<ConnectionState, string> = {
    loading: 'Подключаемся…',
    saved: 'Сохранено',
    saving: 'Сохраняем…',
    offline: 'Нет связи · копия в браузере',
    denied: 'Доступ изменён · обновите страницу',
  };
  return (
    <div className="workspace">
      <header className="workspace-header">
        <a className="icon-button back-button" href="/" title="Мои доски" aria-label="Мои доски">
          <ArrowLeft size={20} />
        </a>
        <Logo />
        <span className="header-separator" />
        <button className="board-name" onClick={() => setEdit('board')} title="Переименовать доску">
          {details?.board.name || 'Доска'}
          <Pencil size={13} />
        </button>
        <div className="header-right">
          <div className={`save-state ${status}`} role="status">
            <span />
            {states[status]}
          </div>
          <button
            className="presence"
            title={['Вы', ...people].join(', ')}
            onClick={() => setNameEdit(true)}
          >
            <Users size={16} />
            <span>{people.length + 1}</span>
          </button>
          {details?.isOwner && (
            <button
              className="button secondary gather-button"
              disabled={
                !current ||
                controls.gatherBusy ||
                status === 'loading' ||
                status === 'offline' ||
                status === 'denied'
              }
              onClick={() => current && void controls.gather(current.id)}
              title="Перевести всех на вашу страницу и показать то же место"
            >
              <Users size={17} /> Собрать всех
            </button>
          )}
          <button className="button primary share-button" onClick={() => void shareBoard()}>
            <Link2 size={17} />
            Поделиться
          </button>
        </div>
      </header>
      {error && (
        <div className="workspace-error" role="alert">
          {error}
          <button
            className="icon-button"
            aria-label="Скрыть сообщение"
            onClick={() => setError('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className={`workspace-body ${sidebar ? '' : 'sidebar-collapsed'}`}>
        <aside className="pages-sidebar">
          <div className="pages-title">
            <span>
              СТРАНИЦЫ <small>{pages?.total || 0}</small>
            </span>
            <button
              className="icon-button"
              title="Новая страница"
              aria-label="Новая страница"
              onClick={() => setEdit('new')}
            >
              <Plus size={18} />
            </button>
          </div>
          <label className="page-search">
            <Search size={14} />
            <input
              aria-label="Поиск страниц"
              placeholder="Найти страницу"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <nav className="pages-list" aria-label="Страницы доски">
            {pages?.items.map((page, i) => (
              <button
                key={page.id}
                className={`page-item ${current?.id === page.id ? 'active' : ''}`}
                onClick={() => selectPage(page)}
                onDoubleClick={() => {
                  selectPage(page);
                  setEdit('page');
                }}
              >
                <span className="page-number">{offset + i + 1}</span>
                <span>{page.name}</span>
                {current?.id === page.id && <span className="current-dot" />}
              </button>
            ))}
          </nav>
          {pages && <Pager offset={offset} total={pages.total} limit={50} onChange={setOffset} />}
          <button className="add-page" onClick={() => setEdit('new')}>
            <Plus size={16} />
            Добавить страницу
          </button>
          <div className="sidebar-bottom">
            <span className="mini-brand">Решайте вместе.</span>
            <p>Места хватит для всех идей.</p>
            <button className="text-button" onClick={() => setHelp(true)}>
              <HelpCircle size={15} />
              Инструменты и клавиши
            </button>
          </div>
        </aside>
        <section className="editor-area">
          <div className="page-heading">
            <button
              className="icon-button"
              aria-label="Показать или скрыть страницы"
              title="Страницы"
              onClick={() => setSidebar(!sidebar)}
            >
              <Layers3 size={17} />
            </button>
            <span className="breadcrumb">
              {details?.board.name}
              <span>/</span>
            </span>
            <button className="current-page-name" onClick={() => setEdit('page')}>
              {current?.name || 'Загрузка…'}
              <Pencil size={12} />
            </button>
            <span className="page-heading-spacer" />
            {details?.isOwner && (
              <button
                className="icon-button"
                aria-label="Удалить страницу"
                title="Удалить страницу"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          {current ? (
            <Suspense fallback={<div className="canvas-loading">Загружаем инструменты…</div>}>
              <Canvas
                key={current.id}
                boardId={id}
                pageId={current.id}
                name={current.name}
                username={username}
                onStatus={setStatus}
                onPeople={setPeople}
                onError={setError}
                grid={controls.grid.enabled}
                gridBusy={controls.gridBusy}
                onToggleGrid={() => void controls.toggleGrid()}
                onBoardEvent={controls.onEvent}
                onCameraReady={controls.cameraReady}
                cameraTarget={controls.target}
                onCameraApplied={controls.targetApplied}
              />
            </Suspense>
          ) : (
            <div className="canvas-loading">
              {error ? 'Доска недоступна по этой ссылке.' : 'Открываем доску…'}
            </div>
          )}
        </section>
      </div>
      {edit && (
        <NameDialog
          title={
            edit === 'board'
              ? 'Название доски'
              : edit === 'page'
                ? 'Название страницы'
                : 'Новая страница'
          }
          value={
            edit === 'board'
              ? details?.board.name || ''
              : edit === 'page'
                ? current?.name || ''
                : `Страница ${(pages?.total || 0) + 1}`
          }
          onClose={() => setEdit(null)}
          onSave={saveName}
        />
      )}
      {share && (
        <Dialog title="Рисуйте вместе" onClose={() => setShare('')}>
          <div className="share-explainer">
            <span>
              <Link2 size={24} />
            </span>
            <div>
              <strong>Доступ по ссылке</strong>
              <p>
                Любой, у кого есть ссылка, сможет рисовать и менять страницы этой доски без
                регистрации.
              </p>
            </div>
          </div>
          <label className="field-label" htmlFor="share-link">
            Ссылка для редактирования
          </label>
          <div className="copy-field">
            <input id="share-link" value={share} readOnly onFocus={(e) => e.target.select()} />
            <button className="button primary" onClick={() => void copy()}>
              {copied ? <Check size={18} /> : <Copy size={18} />} {copied ? 'Готово' : 'Копировать'}
            </button>
          </div>
          <p className="muted">
            Если в ссылке localhost, она работает только на вашем ноутбуке. Для ученика откройте
            доску через сетевой или публичный адрес сервера.
          </p>
          {details?.isOwner && (
            <button className="text-button danger" onClick={() => setRotating(true)}>
              <LockKeyhole size={15} />
              Отозвать старую ссылку
            </button>
          )}
        </Dialog>
      )}
      {rotating && (
        <Dialog title="Заменить ссылку доступа?" onClose={() => setRotating(false)}>
          <p>
            Все подключённые участники будут отключены. Старые ссылки перестанут работать.
            Сохранённые ими ранее копии рисунков остаются у них.
          </p>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => setRotating(false)}>
              Отмена
            </button>
            <button
              className="button primary"
              onClick={() =>
                void request<{ key: string }>(`/boards/${id}/share`, json('POST'))
                  .then(({ key }) => {
                    const url = new URL(`/b/${id}`, location.origin);
                    url.hash = `key=${key}`;
                    setShare(url.href);
                    setRotating(false);
                    setCopied(false);
                  })
                  .catch((e) => setError(message(e)))
              }
            >
              Заменить ссылку
            </button>
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog title="Удалить страницу?" onClose={() => setDeleting(false)}>
          <p>
            Страница «{current?.name}» будет скрыта вместе со всеми рисунками. Последнюю страницу
            удалить нельзя.
          </p>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => setDeleting(false)}>
              Отмена
            </button>
            <button
              className="button danger-button"
              onClick={() =>
                void request(`/boards/${id}/pages/${current?.id}`, json('DELETE'))
                  .then(async () => {
                    setDeleting(false);
                    setCurrent(null);
                    currentRef.current = null;
                    const url = new URL(location.href);
                    url.searchParams.delete('page');
                    history.replaceState(null, '', url);
                    setOffset(0);
                    setQuery('');
                    await load();
                  })
                  .catch((e) => setError(message(e)))
              }
            >
              Удалить страницу
            </button>
          </div>
        </Dialog>
      )}
      {nameEdit && (
        <NameDialog
          title="Ваше имя на доске"
          value={username}
          onClose={() => setNameEdit(false)}
          onSave={async (name) => {
            setUsername(name.slice(0, 40));
            localStorage.setItem('pole-name', name.slice(0, 40));
          }}
        />
      )}
      {help && (
        <Dialog title="Всё под рукой" onClose={() => setHelp(false)}>
          <dl className="shortcuts">
            <dt>
              <kbd>P</kbd> / <kbd>7</kbd>
            </dt>
            <dd>Draw: рисование от руки</dd>
            <dt>
              <kbd>E</kbd>
            </dt>
            <dd>Eraser: удаление целого штриха</dd>
            <dt>
              <kbd>L</kbd>
            </dt>
            <dd>Выбрать прямую; инструмент остаётся выбранным</dd>
            <dt>
              <kbd>C</kbd>
            </dt>
            <dd>Выбрать окружность; инструмент остаётся выбранным</dd>
            <dt>
              <kbd>V</kbd> / <kbd>1</kbd>
            </dt>
            <dd>Select: выделение и перемещение</dd>
            <dt>
              <kbd>H</kbd> / пробел
            </dt>
            <dd>Hand: перемещение по доске</dd>
            <dt>
              <kbd>Ctrl Z</kbd> / <kbd>Ctrl Shift Z</kbd>
            </dt>
            <dd>Отменить / повторить свою правку</dd>
            <dt>
              <kbd>Ctrl C</kbd> / <kbd>Ctrl V</kbd>
            </dt>
            <dd>Копировать / вставить выделенное</dd>
            <dt>
              <kbd>Ctrl D</kbd>
            </dt>
            <dd>Дублировать выделенное</dd>
            <dt>
              <kbd>T</kbd>
            </dt>
            <dd>Написать текст</dd>
          </dl>
          <p className="muted">
            Поворачивайте объекты за круглую ручку выделения. Вставляйте изображения из буфера
            (PNG/JPEG/WebP/GIF до 2 МБ). В меню редактора доступны PNG, SVG и файл .excalidraw. Для
            обычных овалов используйте инструмент эллипса.
          </p>
        </Dialog>
      )}
    </div>
  );
}

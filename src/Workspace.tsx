import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Pencil, Link2, X, Check, Users, Copy, LockKeyhole } from 'lucide-react';
import type { Page, PageList, BoardDetails } from '../shared/types';
import type { ConnectionState } from './canvas/session';
import { request, json, boardKey } from './api';
import { useBoardControls } from './useBoardControls';
import { Dialog, NameDialog, message } from './components/ui';
import { PagePicker } from './components/PagePicker';
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
    [rotating, setRotating] = useState(false);
  const [renamingPage, setRenamingPage] = useState<Page | null>(null);
  const [deleting, setDeleting] = useState<Page | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [username, setUsername] = useState(() => localStorage.getItem('pole-name') || 'Участник');
  const [nameEdit, setNameEdit] = useState(false);
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
  const load = useCallback(
    async (search = query, start = offset) => {
      const [board, list] = await Promise.all([
        request<BoardDetails>(`/boards/${id}`),
        request<PageList<Page>>(
          `/boards/${id}/pages?q=${encodeURIComponent(search)}&limit=50&offset=${start}`,
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
    },
    [id, query, offset, selectPage, controls.acceptGrid],
  );
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
    } else if (edit === 'page' && renamingPage) {
      await request(`/boards/${id}/pages/${renamingPage.id}`, json('PATCH', { name }));
      setCurrent((page) => (page?.id === renamingPage.id ? { ...page, name } : page));
      await load();
    } else {
      const page = await request<Page>(`/boards/${id}/pages`, json('POST', { name }));
      setQuery('');
      setOffset(Math.floor((pages?.total || 0) / 50) * 50);
      selectPage(page);
      await load();
    }
  }
  async function deletePage() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await request(`/boards/${id}/pages/${deleting.id}`, json('DELETE'));
      setDeleting(null);
      if (currentRef.current?.id === deleting.id) {
        setCurrent(null);
        currentRef.current = null;
        const url = new URL(location.href);
        url.searchParams.delete('page');
        history.replaceState(null, '', url);
        setOffset(0);
        setQuery('');
        await load('', 0);
      } else {
        const nextOffset =
          offset && (pages?.total ?? 0) - 1 <= offset ? Math.max(0, offset - 50) : offset;
        setOffset(nextOffset);
        await load(query, nextOffset);
      }
    } catch (error) {
      setDeleteError(message(error));
      setError(message(error));
    } finally {
      setDeleteBusy(false);
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
        <div className="workspace-navigation">
          <a className="icon-button back-button" href="/" title="Мои доски" aria-label="Мои доски">
            <ArrowLeft size={20} />
          </a>
          <button
            className="board-name"
            onClick={() => setEdit('board')}
            title="Переименовать доску"
          >
            {details?.board.name || 'Доска'}
            <Pencil size={13} />
          </button>
          <PagePicker
            pages={pages}
            current={current}
            query={query}
            offset={offset}
            owner={!!details?.isOwner}
            onQuery={(query) => {
              setQuery(query);
              setOffset(0);
            }}
            onOffset={setOffset}
            onSelect={selectPage}
            onNew={() => setEdit('new')}
            onRename={(page) => {
              setRenamingPage(page);
              setEdit('page');
            }}
            onDelete={(page) => {
              setDeleteError('');
              setDeleting(page);
            }}
          />
        </div>
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
          <button
            className="icon-button share-button"
            title="Поделиться"
            aria-label="Поделиться"
            onClick={() => void shareBoard()}
          >
            <Link2 size={17} />
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
      <div className="workspace-body">
        <section className="editor-area">
          {current ? (
            <Suspense fallback={<div className="canvas-loading">Загружаем инструменты…</div>}>
              <Canvas
                key={current.id}
                boardId={id}
                pageId={current.id}
                name={current.name}
                username={username}
                onHelp={() => setHelp(true)}
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
                ? renamingPage?.name || ''
                : `Страница ${(pages?.total || 0) + 1}`
          }
          onClose={() => setEdit(null)}
          onSave={saveName}
        />
      )}
      {share && (
        <Dialog title="Поделиться" className="share-dialog" onClose={() => setShare('')}>
          <label className="field-label" htmlFor="share-link">
            Ссылка для редактирования
          </label>
          <div className="copy-field">
            <input id="share-link" value={share} readOnly onFocus={(e) => e.target.select()} />
            <button className="button primary" onClick={() => void copy()}>
              {copied ? <Check size={18} /> : <Copy size={18} />} {copied ? 'Готово' : 'Копировать'}
            </button>
          </div>
          {details?.isOwner && (
            <button className="text-button share-revoke" onClick={() => setRotating(true)}>
              <LockKeyhole size={15} />
              Отозвать ссылку
            </button>
          )}
        </Dialog>
      )}
      {rotating && (
        <Dialog title="Заменить ссылку доступа?" onClose={() => setRotating(false)}>
          <p>Все подключённые участники будут отключены. Старые ссылки перестанут работать.</p>
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
        <Dialog
          title="Удалить страницу?"
          onClose={() => {
            if (!deleteBusy) setDeleting(null);
          }}
        >
          <p>
            Страница «{deleting.name}» будет скрыта вместе со всеми рисунками. Последнюю страницу
            удалить нельзя.
          </p>
          {deleteError && (
            <p className="form-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={deleteBusy}
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
            <button
              className="button danger-button"
              disabled={deleteBusy}
              onClick={() => void deletePage()}
            >
              {deleteBusy ? 'Удаляем…' : 'Удалить страницу'}
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
            (PNG/JPEG/WebP/GIF до 2 МБ). В меню «Ещё» доступны PNG, SVG и файл .excalidraw.
          </p>
        </Dialog>
      )}
    </div>
  );
}

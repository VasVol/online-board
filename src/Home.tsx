import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  ArrowUpRight,
  Search,
  Layers3,
  BookOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  Download,
  Upload,
  HelpCircle,
} from 'lucide-react';
import type { Board, PageList } from '../shared/types';
import { request, json, download } from './api';
import { Logo, Dialog, NameDialog, Pager, message } from './components/ui';
function Sketch({ variant = 0 }: { variant?: number }) {
  return (
    <svg viewBox="0 0 340 160" className={`board-sketch sketch-${variant % 3}`} aria-hidden="true">
      <defs>
        <pattern id={`dots-${variant}`} width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r=".8" fill="currentColor" opacity=".13" />
        </pattern>
      </defs>
      <rect width="340" height="160" fill={`url(#dots-${variant})`} />
      {variant % 3 === 0 ? (
        <>
          <path
            d="M75 118H265M110 135V30M90 50Q170 192 247 38"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
          <text x="230" y="115">
            x
          </text>
          <text x="125" y="40">
            y
          </text>
          <circle cx="170" cy="116" r="4" fill="currentColor" />
        </>
      ) : variant % 3 === 1 ? (
        <>
          <path d="M95 121L172 30L245 121Z" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M172 30V121" stroke="currentColor" strokeWidth="1" strokeDasharray="5 5" />
          <text x="74" y="130">
            A
          </text>
          <text x="165" y="22">
            B
          </text>
          <text x="250" y="130">
            C
          </text>
          <path d="M172 110h11v11" stroke="currentColor" fill="none" />
        </>
      ) : (
        <>
          <circle cx="172" cy="80" r="52" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M120 80H224M172 80L201 37" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <text x="174" y="69">
            r
          </text>
          <circle cx="172" cy="80" r="3" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
export default function Home() {
  const [boards, setBoards] = useState<PageList<Board> | null>(null),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState('');
  const [edit, setEdit] = useState<Board | 'new' | null>(null),
    [remove, setRemove] = useState<Board | null>(null),
    [menu, setMenu] = useState<string | null>(null),
    [help, setHelp] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      setBoards(await request(`/boards?q=${encodeURIComponent(query)}&offset=${offset}`));
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }, [query, offset]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    return () => clearTimeout(timer);
  }, [load]);
  async function create(name: string) {
    const board = await request<Board>('/boards', json('POST', { name }));
    location.href = `/b/${board.id}`;
  }
  async function restore(file?: File) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.type !== 'pole-owner-key') throw new Error('Выберите файл ключа Поля');
      await request('/session/restore', json('POST', { key: data.key }));
      await load();
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <div className="home">
      <header className="home-header">
        <Logo />
        <span className="workspace-label">Личная мастерская</span>
        <div className="header-right">
          <button className="text-button" onClick={() => setHelp(true)}>
            <HelpCircle size={17} />
            Как это работает
          </button>
          <span className="avatar" title="Ваш браузер — владелец досок">
            В
          </span>
        </div>
      </header>
      <main className="home-main">
        <div className="eyebrow">
          <span /> ПРОСТРАНСТВО ДЛЯ МАТЕМАТИКИ
        </div>
        <div className="home-heading">
          <div>
            <h1>Мои доски</h1>
            <p>От первой идеи до красивого решения.</p>
          </div>
          <button className="button primary" onClick={() => setEdit('new')}>
            <Plus size={19} />
            Новая доска
          </button>
        </div>
        <div className="library-toolbar">
          <div className="library-tab">
            <Layers3 size={17} />
            Все доски<span>{boards?.total ?? '—'}</span>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Поиск досок"
              placeholder="Найти доску…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </label>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void load()}>Повторить</button>
          </div>
        )}
        {!boards && !error ? (
          <div className="empty-state">Загружаем доски…</div>
        ) : boards?.items.length ? (
          <div className="board-grid">
            {boards.items.map((board, i) => (
              <article key={board.id} className="board-card">
                <a
                  className="card-preview"
                  href={`/b/${board.id}`}
                  aria-label={`Открыть ${board.name}`}
                >
                  <Sketch variant={i} />
                  <span className="open-card">
                    <ArrowUpRight size={21} />
                  </span>
                  <span className="cover-caption">{board.pageCount} стр.</span>
                </a>
                <div className="card-info">
                  <div>
                    <a className="card-title" href={`/b/${board.id}`}>
                      {board.name}
                    </a>
                    <p>
                      Создана{' '}
                      {new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(
                        board.createdAt,
                      )}
                    </p>
                  </div>
                  <div className="card-menu-wrap">
                    <button
                      className="icon-button"
                      aria-label={`Действия: ${board.name}`}
                      onClick={() => setMenu(menu === board.id ? null : board.id)}
                    >
                      <MoreHorizontal size={20} />
                    </button>
                    {menu === board.id && (
                      <div className="dropdown">
                        <button
                          onClick={() => {
                            setEdit(board);
                            setMenu(null);
                          }}
                        >
                          <Pencil size={15} />
                          Переименовать
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            setRemove(board);
                            setMenu(null);
                          }}
                        >
                          <Trash2 size={15} />
                          Удалить
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
            <button className="new-card" onClick={() => setEdit('new')}>
              <span>
                <Plus size={24} />
              </span>
              Ещё одна идея?<small>Создать доску</small>
            </button>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-drawing">
              <Sketch variant={1} />
            </div>
            <h2>{query ? 'Ничего не нашлось' : 'Начнём с чистого листа'}</h2>
            <p>
              {query
                ? 'Попробуйте другое название.'
                : 'Создайте доску, пригласите ученика и решайте вместе.'}
            </p>
            {!query && (
              <button className="button primary" onClick={() => setEdit('new')}>
                <Plus size={18} />
                Создать первую доску
              </button>
            )}
          </div>
        )}
        {boards && <Pager offset={offset} total={boards.total} onChange={setOffset} />}
        <div className="home-note">
          <BookOpen size={21} />
          <div>
            <strong>Одна доска — целое занятие.</strong>
            <p>Добавляйте страницы для новых задач. Делитесь ссылкой, чтобы рисовать вместе.</p>
          </div>
          <span className="note-mark">x² + y²</span>
        </div>
      </main>
      <footer className="home-footer">
        <span>Поле · свои идеи, свой сервер</span>
        <div>
          <button
            className="text-button"
            onClick={() =>
              void request('/session/export')
                .then((data) => download('pole-owner-key.json', JSON.stringify(data, null, 2)))
                .catch((e) => setError(message(e)))
            }
          >
            <Download size={15} />
            Сохранить ключ владельца
          </button>
          <button className="text-button" onClick={() => restoreInput.current?.click()}>
            <Upload size={15} />
            Восстановить доступ
          </button>
          <input
            type="file"
            accept=".json"
            ref={restoreInput}
            hidden
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </div>
      </footer>
      {edit && (
        <NameDialog
          title={edit === 'new' ? 'Новая доска' : 'Название доски'}
          value={edit === 'new' ? 'Новое занятие' : edit.name}
          onClose={() => setEdit(null)}
          onSave={async (name) => {
            if (edit === 'new') await create(name);
            else {
              await request(`/boards/${edit.id}`, json('PATCH', { name }));
              await load();
            }
          }}
        />
      )}
      {remove && (
        <Dialog title="Удалить доску?" onClose={() => setRemove(null)}>
          <p>
            «{remove.name}» исчезнет из каталога, а ссылка доступа перестанет работать. Для
            восстановления понадобится резервная копия сервера.
          </p>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => setRemove(null)}>
              Отмена
            </button>
            <button
              className="button danger-button"
              onClick={() =>
                void request(`/boards/${remove.id}`, json('DELETE'))
                  .then(() => {
                    setRemove(null);
                    return load();
                  })
                  .catch((e) => setError(message(e)))
              }
            >
              Удалить доску
            </button>
          </div>
        </Dialog>
      )}
      {help && (
        <Dialog title="Ваше пространство для занятий" onClose={() => setHelp(false)}>
          <div className="help-list">
            <p>
              <strong>1. Создайте доску.</strong> Назовите её по теме или имени ученика. Внутри
              можно добавлять страницы.
            </p>
            <p>
              <strong>2. Пригласите ученика.</strong> Кнопка «Поделиться» копирует ссылку с правом
              редактирования. Регистрация не нужна.
            </p>
            <p>
              <strong>3. Сохраните ключ владельца.</strong> Доски в каталоге привязаны к этому
              браузеру. Ключ восстановит ваш каталог на другом устройстве. Храните его у себя.
            </p>
            <p className="muted">
              Для доступа извне сервер должен быть доступен ученику: одна локальная сеть либо
              публичный HTTPS-адрес. Настройка описана в README проекта.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  Search,
  Layers3,
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
        <div className="header-right">
          <button className="text-button" onClick={() => setHelp(true)}>
            <HelpCircle size={17} />
            Как это работает
          </button>
        </div>
      </header>
      <main className="home-main">
        <div className="home-heading">
          <div>
            <h1>Мои доски</h1>
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
            {boards.items.map((board) => (
              <article key={board.id} className="board-card">
                <div className="card-info">
                  <div>
                    <a
                      className="card-title"
                      href={`/b/${board.id}`}
                      aria-label={`Открыть ${board.name}`}
                    >
                      {board.name}
                    </a>
                    <p>
                      {board.pageCount} стр. <span aria-hidden="true">·</span>{' '}
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
          </div>
        ) : (
          <div className="empty-state">
            <h2>{query ? 'Ничего не нашлось' : 'Пока нет досок'}</h2>
            <p>{query ? 'Попробуйте другое название.' : 'Создайте доску для занятия.'}</p>
            {!query && (
              <button className="button primary" onClick={() => setEdit('new')}>
                <Plus size={18} />
                Создать первую доску
              </button>
            )}
          </div>
        )}
        {boards && <Pager offset={offset} total={boards.total} onChange={setOffset} />}
      </main>
      <footer className="home-footer">
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
        <Dialog title="Как это работает" onClose={() => setHelp(false)}>
          <div className="help-list">
            <p>
              <strong>Создайте доску.</strong> Добавляйте страницы для разных задач.
            </p>
            <p>
              <strong>Пригласите ученика.</strong> Отправьте ему ссылку из «Поделиться».
            </p>
            <p>
              <strong>Сохраните ключ владельца.</strong> Он вернёт доступ к вашим доскам в другом
              браузере или на другом устройстве.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

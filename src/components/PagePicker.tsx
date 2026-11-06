import { Layers3, ChevronDown, Plus, Search, Trash2 } from 'lucide-react';
import type { Page, PageList } from '../../shared/types';
import { Pager } from './ui';
import { Popover } from './Popover';
export function PagePicker({
  pages,
  current,
  query,
  offset,
  owner,
  onQuery,
  onOffset,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  pages: PageList<Page> | null;
  current: Page | null;
  query: string;
  offset: number;
  owner: boolean;
  onQuery: (query: string) => void;
  onOffset: (offset: number) => void;
  onSelect: (page: Page) => void;
  onNew: () => void;
  onRename: (page: Page) => void;
  onDelete: (page: Page) => void;
}) {
  return (
    <Popover
      label="Страницы"
      className="page-picker"
      trigger={
        <>
          <Layers3 size={17} />
          <span>{current?.name || 'Страницы'}</span>
          <ChevronDown size={14} />
        </>
      }
    >
      {(close) => (
        <>
          <div className="pages-title">
            <span>
              Страницы <small>{pages?.total || 0}</small>
            </span>
          </div>
          <label className="page-search">
            <Search size={14} />
            <input
              aria-label="Поиск страниц"
              placeholder="Найти страницу"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
          </label>
          <nav className="pages-list" aria-label="Страницы доски">
            {pages?.items.map((page, i) => (
              <div className={`page-row ${current?.id === page.id ? 'active' : ''}`} key={page.id}>
                <button
                  className={`page-item ${current?.id === page.id ? 'active' : ''}`}
                  aria-current={current?.id === page.id ? 'page' : undefined}
                  title={`${page.name} — двойной клик для переименования`}
                  aria-keyshortcuts="F2"
                  onClick={() => onSelect(page)}
                  onDoubleClick={() => {
                    close();
                    onRename(page);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'F2') {
                      event.preventDefault();
                      close();
                      onRename(page);
                    }
                  }}
                >
                  <span className="page-number">{offset + i + 1}</span>
                  <span>{page.name}</span>
                </button>
                {owner && (
                  <button
                    className="page-delete"
                    title={`Удалить страницу «${page.name}»`}
                    aria-label={`Удалить страницу «${page.name}»`}
                    onClick={() => {
                      close();
                      onDelete(page);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            {pages?.items.length === 0 && <p className="muted">Страницы не найдены</p>}
          </nav>
          {pages && <Pager offset={offset} total={pages.total} limit={50} onChange={onOffset} />}
          <div className="popover-separator" />
          <button
            className="page-create"
            onClick={() => {
              close();
              onNew();
            }}
          >
            <Plus size={16} />
            Новая страница
          </button>
        </>
      )}
    </Popover>
  );
}

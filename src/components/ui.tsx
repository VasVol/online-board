import { useState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
const PAGE_SIZE = 24;
export function Logo() {
  return (
    <a className="brand" href="/" aria-label="Поле — мои доски">
      <span className="brand-icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path
            d="M4 17V5h14M8 17V9h10M12 17v-4h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      поле<span className="brand-dot">.</span>
    </a>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-title">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function NameDialog({
  title,
  value,
  onClose,
  onSave,
}: {
  title: string;
  value: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [name, setName] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="new-name">
          Название
        </label>
        <input
          id="new-name"
          autoFocus
          value={name}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          required
        />
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={!name.trim() || busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function message(e: unknown) {
  return e instanceof Error ? e.message : 'Не удалось выполнить действие';
}
export function Pager({
  offset,
  total,
  onChange,
  limit = PAGE_SIZE,
}: {
  offset: number;
  total: number;
  onChange: (n: number) => void;
  limit?: number;
}) {
  if (total <= limit) return null;
  return (
    <div className="pager">
      <button
        className="icon-button"
        disabled={!offset}
        aria-label="Предыдущие"
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft size={18} />
      </button>
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} из {total}
      </span>
      <button
        className="icon-button"
        disabled={offset + limit >= total}
        aria-label="Следующие"
        onClick={() => onChange(offset + limit)}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Dialog, message } from '../components/ui';
import coordinateGrid from '../assets/coordinate-grid.png';

const pictures = [
  { name: 'Координатная плоскость', url: coordinateGrid, filename: 'coordinate-grid.png' },
];

export function ImageLibrary({
  onInsert,
  onClose,
}: {
  onInsert: (file: File, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function insert(picture: (typeof pictures)[number]) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(picture.url, { signal: request.signal });
      if (!response.ok) throw new Error('Не удалось загрузить картинку. Попробуйте ещё раз.');
      const blob = await response.blob();
      request.signal.throwIfAborted();
      await onInsert(new File([blob], picture.filename, { type: 'image/png' }), request.signal);
      onClose();
    } catch (e) {
      if (!request.signal.aborted) setError(message(e));
    } finally {
      if (!request.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <Dialog title="Библиотека картинок" onClose={onClose}>
      <p>Нажмите на картинку, чтобы добавить её в центр текущей страницы.</p>
      <div className="image-library" aria-busy={busy}>
        {pictures.map((picture) => (
          <button
            key={picture.filename}
            className="image-library-card"
            disabled={busy}
            onClick={() => void insert(picture)}
            aria-label={`Добавить: ${picture.name}`}
          >
            <img src={picture.url} alt="" width="220" height="220" />
            <strong>{picture.name}</strong>
            <span>{busy ? 'Добавляем…' : 'Добавить на доску'}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

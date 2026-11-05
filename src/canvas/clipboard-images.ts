import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import { insertImage } from './insert-image';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

async function animatedPng(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += view.getUint32(offset) + 12;
  }
  return false;
}

// Flat backgrounds and sharp ink use a verified lossless conversion. Dense,
// small variations in opaque neighbouring pixels identify photographic texture.
function photographic(pixels: Uint8ClampedArray, width: number, height: number) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / 20_000)));
  let textured = 0,
    samples = 0;
  for (let y = 1; y < height; y += step)
    for (let x = 1; x < width; x += step) {
      const i = (y * width + x) * 4;
      const difference =
        Math.abs(pixels[i] - pixels[i - 4]) +
        Math.abs(pixels[i + 1] - pixels[i - 3]) +
        Math.abs(pixels[i + 2] - pixels[i - 2]);
      if (difference > 0 && difference < 120) textured++;
      samples++;
    }
  return textured > samples * 0.35;
}

export async function prepareClipboardImage(file: File, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  if (file.size > MAX_INPUT_BYTES)
    throw new Error('Изображение из буфера слишком большое. Загрузите исходный JPEG до 2 МБ.');
  // Preserve existing JPEG/WebP/GIF bytes (and animation), and small PNGs.
  if (file.type !== 'image/png' || file.size < 128 * 1024) return file;
  if (await animatedPng(file)) return file;
  let bitmap: ImageBitmap | undefined;
  const canvas = document.createElement('canvas');
  try {
    bitmap = await createImageBitmap(file);
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > MAX_PIXELS)
      throw new Error('Изображение из буфера слишком большое по разрешению (максимум 24 Мп).');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return file;
      context.drawImage(bitmap, 0, 0);
      const original = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const photo = photographic(original, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', photo ? 0.9 : 1),
      );
      signal.throwIfAborted();
      // Unsupported encoders may silently return PNG. Never enlarge the input.
      if (!blob || blob.type !== 'image/webp' || blob.size > file.size * 0.9) return file;
      if (!photo) {
        // quality=1 is lossless in Chromium, but that is not a cross-browser API
        // guarantee. Check actual decoded RGBA before replacing a diagram or alpha.
        const converted = await createImageBitmap(blob);
        try {
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(converted, 0, 0);
          const next = context.getImageData(0, 0, canvas.width, canvas.height).data;
          if (!original.every((value, index) => value === next[index])) return file;
        } finally {
          converted.close();
        }
      }
      signal.throwIfAborted();
      return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.webp', { type: blob.type });
    } catch {
      signal.throwIfAborted();
      // Keep the source if this browser cannot encode or verify the conversion.
      // insertImage still enforces the ordinary 2 MiB storage limit.
      return file;
    }
  } finally {
    bitmap?.close();
    canvas.width = canvas.height = 0;
  }
}

export function installImagePaste(
  root: HTMLElement,
  api: ExcalidrawImperativeAPI,
  accept: (file: BinaryFileData) => void,
  error: (message: string) => void,
  onPending: (pending: boolean) => void,
) {
  const controller = new AbortController();
  let pointer: { clientX: number; clientY: number } | undefined;
  let queue = Promise.resolve();
  let pending = 0;
  const move = (event: PointerEvent) => {
    pointer = { clientX: event.clientX, clientY: event.clientY };
  };
  const paste = (event: ClipboardEvent) => {
    const active = document.activeElement;
    if (
      !root.contains(active) ||
      api.getAppState().viewModeEnabled ||
      active?.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]',
      )
    )
      return;
    const data = event.clipboardData;
    if (!data) return;
    // Keep native Excalidraw copying of objects, groups and their existing files.
    try {
      if (JSON.parse(data.getData('text/plain')).type === 'excalidraw/clipboard') return;
    } catch {
      /* Ordinary image clipboard contents need not contain JSON. */
    }
    const files = Array.from(data.files).filter((file) => IMAGE_TYPES.has(file.type));
    if (!files.length) return;
    const state = api.getAppState();
    const position = pointer || {
      clientX: state.offsetLeft + state.width / 2,
      clientY: state.offsetTop + state.height / 2,
    };
    if (
      !(document.elementFromPoint(position.clientX, position.clientY) instanceof HTMLCanvasElement)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = viewportCoordsToSceneCoords(position, state);
    pending++;
    onPending(true);
    queue = queue
      .then(async () => {
        for (const file of files) {
          const prepared = await prepareClipboardImage(file, controller.signal);
          await insertImage(prepared, api, accept, controller.signal, point);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          error(e instanceof Error ? e.message : 'Не удалось вставить изображение.');
      })
      .finally(() => {
        pending--;
        if (!controller.signal.aborted) onPending(pending > 0);
      });
  };
  root.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('paste', paste, true);
  return () => {
    controller.abort();
    root.removeEventListener('pointermove', move);
    document.removeEventListener('paste', paste, true);
  };
}

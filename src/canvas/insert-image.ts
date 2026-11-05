import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

// Uploads, clipboard and built-in library all use the normal server file queue.
export async function insertImage(
  file: File,
  api: ExcalidrawImperativeAPI,
  accept: (file: BinaryFileData) => void,
  signal?: AbortSignal,
  position?: { x: number; y: number },
) {
  const state = api.getAppState();
  const point =
    position ||
    viewportCoordsToSceneCoords(
      { clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 },
      state,
    );
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
  signal?.throwIfAborted();
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('') as BinaryFileData['id'];
  const binary: BinaryFileData = {
    id,
    dataURL: dataURL as BinaryFileData['dataURL'],
    mimeType: file.type as BinaryFileData['mimeType'],
    created: Date.now(),
  };
  const scale = Math.min(1, 600 / image.naturalWidth, 500 / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  accept(binary);
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
    appState: { selectedElementIds: { [elements[0].id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  // addFiles builds the SDK image cache from the current scene. The element
  // must already exist, otherwise the inserting client can keep a placeholder.
  api.addFiles([binary]);
  api.setActiveTool({ type: 'selection' });
}

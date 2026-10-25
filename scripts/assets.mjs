import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/excalidraw-assets', { recursive: true });
cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/excalidraw-assets/fonts', {
  recursive: true,
});

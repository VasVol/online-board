// Excalidraw 0.18.1 exposes no option to disable freehand pressure/thinning.
// Keep a tiny, reproducible renderer adaptation instead of changing stored scenes
// or replacing the editor's input/history/collaboration machinery.
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@excalidraw/excalidraw/', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (version !== '0.18.1') throw new Error(`Review uniform pen patch for Excalidraw ${version}`);

const variants = [
  {
    directory: 'dev',
    before: 'size: element.strokeWidth * 4.25,\n    thinning: 0.6,',
    after: 'size: element.strokeWidth,\n    thinning: 0,',
  },
  {
    directory: 'prod',
    before: 'size:e.strokeWidth*4.25,thinning:.6,',
    after: 'size:e.strokeWidth,thinning:0,',
  },
];
// Validate both bundles before writing either. Unknown upstream output must fail
// loudly; never silently ship a dev-only or production-only pressure fix.
const edits = [];
for (const variant of variants) {
  const dir = new URL(`dist/${variant.directory}/`, root);
  const matches = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue;
    const file = new URL(name, dir);
    const source = await readFile(file, 'utf8');
    const beforeCount = source.split(variant.before).length - 1;
    const afterCount = source.split(variant.after).length - 1;
    if (!beforeCount && !afterCount) continue;
    if (beforeCount + afterCount !== 1) throw new Error(`Ambiguous pen renderer: ${name}`);
    matches.push({ file, source, beforeCount });
  }
  if (matches.length !== 1) throw new Error(`Cannot locate ${variant.directory} pen renderer`);
  const match = matches[0];
  if (match.beforeCount) {
    edits.push({ file: match.file, source: match.source.replace(variant.before, variant.after) });
  }
}
for (const { file, source } of edits) {
  await writeFile(file, source);
  console.log(`Uniform pen: patched ${fileURLToPath(file).split('/').at(-1)}`);
}
if (edits.length) {
  // The SDK is prebundled by Vite; an old generated cache can hide this change.
  await rm(new URL('../node_modules/.vite/', import.meta.url), { recursive: true, force: true });
}

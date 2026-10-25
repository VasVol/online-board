// Serve an isolated production build so renderer patches are checked in both
// published SDK bundles. Never replace the user's dist/ or open their database.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server/app.js';

const directory = await mkdtemp(join(tmpdir(), 'pole-production-e2e-'));
const staticDir = join(directory, 'web');
let instance: ReturnType<typeof createApp> | undefined;
const builder = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'build', '--outDir', staticDir],
  { stdio: 'inherit', env: { ...process.env, VITE_E2E: 'true' } },
);
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (builder.exitCode === null && builder.signalCode === null) {
    await new Promise<void>((resolve) => {
      builder.once('exit', () => resolve());
      builder.kill('SIGTERM');
    });
  }
  await instance?.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
const code = await new Promise<number | null>((resolve, reject) => {
  builder.once('exit', resolve);
  builder.once('error', reject);
});
if (code !== 0) await close(1);
instance = createApp({
  dbPath: join(directory, 'board.sqlite'),
  staticDir,
  publicOrigin: 'http://127.0.0.1:4310',
});
instance.server.listen(4310, '127.0.0.1');

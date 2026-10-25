import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'pole-e2e-'));
const env = {
  ...process.env,
  DATA_DIR: directory,
  PORT: '4311',
  HOST: '127.0.0.1',
  PUBLIC_ORIGIN: 'http://127.0.0.1:4310',
  VITE_E2E: 'true',
  API_TARGET: 'http://127.0.0.1:4311',
};
const commands = [
  ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'],
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4310', '--strictPort'],
];
const children = commands.map((args) => spawn(process.execPath, args, { stdio: 'inherit', env }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
for (const child of children)
  child.on('exit', () => {
    if (!closing) void close();
  });

import { resolve } from 'node:path';
import { createApp } from './app.js';
process.umask(0o077);
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
const instance = createApp({
  dbPath: resolve(process.env.DATA_DIR || 'data', 'board.sqlite'),
  publicOrigin: process.env.PUBLIC_ORIGIN,
});
instance.server.listen(port, host, () =>
  console.log(`Поле: http://localhost:${port} (listen ${host})`),
);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await instance.close();
    process.exit(0);
  });

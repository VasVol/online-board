import { resolve } from 'node:path';
import { createApp } from './app.js';
import { readFileSync, existsSync } from 'node:fs';
import { DeploymentGate, listenDeploymentControl } from './deployment.js';
process.umask(0o077);
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
const deployment = new DeploymentGate();
const revision = existsSync('release.json')
  ? JSON.parse(readFileSync('release.json', 'utf8')).sha
  : undefined;
const instance = createApp({
  dbPath: resolve(process.env.DATA_DIR || 'data', 'board.sqlite'),
  publicOrigin: process.env.PUBLIC_ORIGIN,
  trustLocalProxy: process.env.TRUST_LOCAL_PROXY === '1',
  revision,
  deployment,
});
const closeControl = process.env.DEPLOY_CONTROL_SOCKET
  ? await listenDeploymentControl(process.env.DEPLOY_CONTROL_SOCKET, deployment)
  : undefined;
instance.server.listen(port, host, () =>
  console.log(`Поле: http://localhost:${port} (listen ${host})`),
);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await closeControl?.();
    await instance.close();
    process.exit(0);
  });

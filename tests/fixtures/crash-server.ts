import { createApp } from '../../server/app.js';
import type { AddressInfo } from 'node:net';
const app = createApp({ dbPath: process.env.TEST_DB! });
app.server.listen(0, '127.0.0.1', () =>
  process.send?.({ port: (app.server.address() as AddressInfo).port }),
);

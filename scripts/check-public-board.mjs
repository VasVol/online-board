// Real production smoke test, without VITE_E2E/debug access or existing owner cookies.
// Creates only its own synthetic board and removes it through the owner API afterwards.
import { chromium, expect } from '@playwright/test';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const base = (
  process.env.BOARD_URL ||
  (await readFile(`${homedir()}/.local/state/online-board/public-url`, 'utf8'))
).trim();
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(base))
  throw new Error('BOARD_URL must be an HTTPS origin');
const output = 'test-results/public-smoke';
await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BOARD_PROXY
    ? { proxy: { server: process.env.BOARD_PROXY } }
    : { args: ['--no-proxy-server'] }),
});
const contextOptions = {
  viewport: { width: 1440, height: 1000 },
  ...(base.endsWith('.pinggy-free.link')
    ? { extraHTTPHeaders: { 'X-Pinggy-No-Screen': '1' } }
    : {}),
};
const owner = await browser.newContext(contextOptions);
const guest = await browser.newContext(contextOptions);
owner.setDefaultTimeout(30000);
guest.setDefaultTimeout(30000);
let boardId;
const errors = [];
const mirrors = [];
function observe(page) {
  const doc = new Y.Doc();
  mirrors.push(doc);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(base.replace('https:', 'wss:') + '/sync/')) return;
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      const decoder = decoding.createDecoder(new Uint8Array(payload));
      if (decoding.readVarUint(decoder) !== 0) return;
      const subtype = decoding.readVarUint(decoder);
      if (subtype === 1 || subtype === 2) Y.applyUpdate(doc, decoding.readVarUint8Array(decoder));
    });
  });
  return () => [...doc.getMap('elements').values()].filter((e) => !e.isDeleted);
}
async function ready(page) {
  await expect(page.getByRole('status')).toHaveText('Сохранено', { timeout: 90000 });
}
async function draw(page, x, y, color) {
  await page.getByLabel('Цвет пера', { exact: true }).fill(color);
  await page.getByRole('button', { name: 'Draw — карандаш (P)', exact: true }).click();
  const box = await page.getByTestId('drawing-surface').boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 100, box.y + y + 45, { steps: 20 });
  await page.mouse.move(box.x + x + 180, box.y + y - 30, { steps: 20 });
  await page.mouse.up();
}
async function colors(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.static');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0,
      blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 100) continue;
      if (pixels[i] > 150 && pixels[i + 1] < 120 && pixels[i + 2] < 120) red++;
      if (pixels[i + 2] > 150 && pixels[i] < 120 && pixels[i + 1] < 150) blue++;
    }
    return red > 100 && blue > 100;
  });
}
try {
  const a = await owner.newPage();
  const b = await guest.newPage();
  const elementsA = observe(a),
    elementsB = observe(b);
  await a.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('Public catalog loaded');
  await a.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await a.getByLabel('Название', { exact: true }).fill('Проверка внешнего доступа — тест');
  await a.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await a.waitForURL(/\/b\//);
  boardId = new URL(a.url()).pathname.split('/')[2];
  console.log('Synthetic board created');
  await ready(a);
  console.log('Owner WebSocket synchronized');
  expect((await owner.cookies(base)).find((c) => c.name === 'pole_owner')?.secure).toBe(true);
  await a.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const link = await a.getByLabel('Ссылка для редактирования').inputValue();
  await a.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await b.goto(link, { timeout: 60000 });
  await ready(b);
  await Promise.all([draw(a, 350, 300, '#e03131'), draw(b, 650, 440, '#1971c2')]);
  await expect.poll(() => elementsA().length, { timeout: 20000 }).toBe(2);
  await expect.poll(() => elementsB().length, { timeout: 20000 }).toBe(2);
  await expect.poll(() => colors(a)).toBe(true);
  await expect.poll(() => colors(b)).toBe(true);
  await Promise.all([ready(a), ready(b)]);
  console.log(
    'PASS: two independent browsers draw through public HTTPS/WSS; Secure cookie; actual canvas pixels',
  );
  await guest.setOffline(true);
  await expect(b.getByRole('status')).toContainText('Нет связи');
  await draw(b, 600, 260, '#1971c2');
  await draw(a, 400, 520, '#e03131');
  await guest.setOffline(false);
  await ready(b);
  await expect.poll(() => elementsA().length, { timeout: 20000 }).toBe(4);
  await expect.poll(() => elementsB().length, { timeout: 20000 }).toBe(4);
  await ready(a);
  // Close both active scenes before restarting: a cached client must not be able
  // to repopulate an empty server and hide a persistence regression.
  await Promise.all([a.close(), b.close()]);
  if (process.argv.includes('--restart-local')) {
    execFileSync('systemctl', ['--user', 'restart', 'pole.service']);
  }
  const fresh = await browser.newContext(contextOptions);
  try {
    const c = await fresh.newPage();
    const elementsC = observe(c);
    await c.goto(link, { timeout: 60000 });
    await ready(c);
    await expect.poll(() => elementsC().length, { timeout: 20000 }).toBe(4);
    await expect.poll(() => colors(c)).toBe(true);
    await c.screenshot({ path: `${output}/guest.png` });
    const denied = await fresh.request.get(`${base}/api/boards/${boardId}`);
    expect(denied.status()).toBe(404);
  } finally {
    await fresh.close();
  }
  expect(errors).toEqual([]);
  console.log(
    'PASS: offline/reconnect and fresh guest without cache; persistence; unrelated access denied',
  );
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        ok: true,
        origin: base,
        restart: process.argv.includes('--restart-local'),
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} catch (error) {
  console.error('Page errors:', errors);
  const page = owner.pages()[0];
  if (page) {
    await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
    console.error('Canvas count:', await page.locator('canvas').count());
  }
  // Never print a Playwright call log containing a guest capability URL.
  console.error(String(error).replace(/([?#&]key=)[A-Za-z0-9_-]+/g, '$1<redacted>'));
  process.exitCode = 1;
} finally {
  if (boardId) {
    const cleanup = await owner.request
      .delete(`${base}/api/boards/${boardId}`)
      .catch(() => undefined);
    if (cleanup?.status() !== 200) console.error('Synthetic board cleanup could not complete');
  }
  await browser.close();
  mirrors.forEach((doc) => doc.destroy());
}

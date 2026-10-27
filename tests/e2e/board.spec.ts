import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { PageSession } from '../../src/canvas/session';
declare global {
  interface Window {
    __board: { api: ExcalidrawImperativeAPI; session: PageSession; flush: () => void };
  }
}
async function elements(page: Page) {
  return page.evaluate(() =>
    window.__board.api.getSceneElements().map((e) => ({
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      angle: e.angle,
      strokeStyle: e.strokeStyle,
      strokeWidth: e.strokeWidth,
      opacity: e.opacity,
      strokeColor: e.strokeColor,
    })),
  );
}
async function ready(page: Page) {
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => !!window.__board?.session.provider.synced))
    .toBeTruthy();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
}
async function create(page: Page, name = 'Тестовый урок') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForURL(/\/b\//);
  await ready(page);
}
async function stroke(page: Page, x = 480, y = 370) {
  const box = await page.getByTestId('drawing-surface').boundingBox();
  if (!box) throw new Error('No canvas');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 50, box.y + y + 30, { steps: 8 });
  await page.mouse.move(box.x + x + 100, box.y + y - 20, { steps: 8 });
  await page.mouse.up();
}

test('drawing, persistent L/C, styles, undo/redo, pages and reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await create(page);
  await stroke(page);
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  expect((await elements(page))[0].type).toBe('freedraw');
  await page.keyboard.press('KeyL');
  await stroke(page, 490, 480);
  await expect.poll(async () => (await elements(page)).length).toBe(2);
  expect((await elements(page))[1].type).toBe('line');
  expect(await page.evaluate(() => window.__board.api.getAppState().activeTool.customType)).toBe(
    'straight',
  );
  await page.keyboard.press('KeyC');
  await stroke(page, 720, 400);
  await expect.poll(async () => (await elements(page)).length).toBe(3);
  const circle = (await elements(page))[2];
  expect(circle.type).toBe('ellipse');
  expect(circle.width).toBe(circle.height);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await elements(page)).length).toBe(2);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await elements(page)).length).toBe(3);
  await page.getByLabel('Стиль пера', { exact: true }).selectOption('dashed');
  await page.getByLabel('Толщина пера', { exact: true }).selectOption('4');
  await page.getByLabel('Цвет пера', { exact: true }).fill('#e03131');
  await page.getByRole('button', { name: 'Draw — карандаш (P)', exact: true }).click();
  await stroke(page, 710, 560);
  await expect.poll(async () => (await elements(page)).length).toBe(4);
  await expect.poll(async () => (await elements(page))[3].type).toBe('line');
  expect((await elements(page))[3]).toMatchObject({
    strokeStyle: 'dashed',
    strokeWidth: 4,
    strokeColor: '#e03131',
  });
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Геометрия LC');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await ready(page);
  expect(await elements(page)).toHaveLength(0);
  await stroke(page);
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  await page
    .getByRole('navigation', { name: 'Страницы доски' })
    .getByRole('button', { name: '1 Страница 1' })
    .click();
  await ready(page);
  await expect.poll(async () => (await elements(page)).length).toBe(4);
  await page.reload();
  await ready(page);
  expect(await elements(page)).toHaveLength(4);
  await page.screenshot({ path: 'test-results/editor.png' });
  expect(errors).toEqual([]);
});

test('pen width stays constant with mouse speed and stylus pressure, live and after reload', async ({
  page,
  context,
}) => {
  await create(page, 'Ровное перо');
  await page.getByLabel('Цвет пера', { exact: true }).fill('#e03131');
  await page.getByLabel('Толщина пера', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Draw — карандаш (P)', exact: true }).click();
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  const x = box.x + 500;
  const y = box.y + 350;
  async function widths(y: number) {
    return page.evaluate(
      ({ x, y }) => {
        // In-progress strokes live on the interactive canvas; committed ones on static.
        const layers = [
          ...document.querySelectorAll<HTMLCanvasElement>('canvas.excalidraw__canvas'),
        ].map((canvas) => ({
          rect: canvas.getBoundingClientRect(),
          scale: canvas.width / canvas.getBoundingClientRect().width,
          ctx: canvas.getContext('2d')!,
        }));
        return [40, 80, 140, 180, 240, 280].map((dx) => {
          let count = 0;
          for (let dy = -25; dy <= 25; dy++) {
            if (
              layers.some(({ rect, scale, ctx }) => {
                const p = ctx.getImageData(
                  Math.round((x + dx - rect.x) * scale),
                  Math.round((y + dy - rect.y) * scale),
                  1,
                  1,
                ).data;
                return p[0] > 150 && p[1] < 120 && p[2] < 120 && p[3] > 100;
              })
            )
              count++;
          }
          return count;
        });
      },
      { x, y },
    );
  }
  async function expectUniform(y: number) {
    await expect.poll(async () => (await widths(y)).every((n) => n >= 3 && n <= 5)).toBeTruthy();
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 50 });
  await page.mouse.move(x + 200, y, { steps: 4 });
  await page.mouse.move(x + 320, y, { steps: 60 });
  await expectUniform(y); // Before pointerup, not just a conversion after the gesture.
  await page.mouse.up();
  await expectUniform(y);

  const pen = await context.newCDPSession(page);
  try {
    await pen.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y: y + 100,
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.1,
      clickCount: 1,
    });
    for (let dx = 4; dx <= 320; dx += 4) {
      await pen.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x + dx,
        y: y + 100,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
        force: dx < 100 ? 0.1 : dx < 200 ? 0.95 : 0.4,
      });
    }
    await expectUniform(y + 100);
    await pen.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x + 320,
      y: y + 100,
      button: 'left',
      buttons: 0,
      pointerType: 'pen',
      force: 0,
      clickCount: 1,
    });
  } finally {
    await pen.detach();
  }
  await expect.poll(async () => (await elements(page)).length).toBe(2);
  await ready(page);
  await page.reload();
  await ready(page);
  await expectUniform(y);
  await expectUniform(y + 100);
  await page.screenshot({ path: 'test-results/uniform-pen.png' });
});

test('dashed and dotted pens render visible gaps, including after reload', async ({ page }) => {
  await create(page, 'Пунктир');
  await page.getByLabel('Цвет пера', { exact: true }).fill('#e03131');
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  async function redCoverage(y: number) {
    return page.evaluate(
      ({ x, y }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          'canvas.excalidraw__canvas.static',
        )!;
        const rect = canvas.getBoundingClientRect();
        const scale = canvas.width / rect.width;
        const ctx = canvas.getContext('2d')!;
        let red = 0;
        for (let dx = 10; dx < 190; dx += 2) {
          const pixel = ctx.getImageData(
            Math.round((x + dx - rect.x) * scale),
            Math.round((y - rect.y) * scale),
            1,
            1,
          ).data;
          if (pixel[0] > 150 && pixel[1] < 120 && pixel[2] < 120 && pixel[3] > 100) red++;
        }
        return red;
      },
      { x: box.x + 500, y: box.y + y },
    );
  }
  for (const [style, y] of [
    ['dashed', 380],
    ['dotted', 480],
  ] as const) {
    await page.getByLabel('Стиль пера', { exact: true }).selectOption(style);
    await page.getByRole('button', { name: 'Draw — карандаш (P)', exact: true }).click();
    await page.mouse.move(box.x + 500, box.y + y);
    await page.mouse.down();
    // Dense pointer samples reproduce dash restart on every short polyline segment.
    await page.mouse.move(box.x + 700, box.y + y, { steps: 80 });
    await page.mouse.up();
    await expect.poll(() => redCoverage(y)).toBeGreaterThan(10);
    await expect.poll(() => redCoverage(y)).toBeLessThan(75);
  }
  await ready(page);
  await page.reload();
  await ready(page);
  for (const y of [380, 480]) {
    await expect.poll(() => redCoverage(y)).toBeGreaterThan(10);
    await expect.poll(() => redCoverage(y)).toBeLessThan(75);
  }
});

test('two independent browsers: simultaneous drawing, local undo, disconnect and catch-up', async ({
  page,
  browser,
}) => {
  await create(page, 'Совместный урок');
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guest = await context.newPage();
  try {
    await guest.goto(url);
    await ready(guest);
    await Promise.all([stroke(page, 450, 350), stroke(guest, 750, 500)]);
    await expect.poll(async () => (await elements(page)).length).toBe(2);
    await expect.poll(async () => (await elements(guest)).length).toBe(2);
    expect((await elements(page)).map((e) => e.id).sort()).toEqual(
      (await elements(guest)).map((e) => e.id).sort(),
    );
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await elements(page)).length).toBe(1);
    await expect.poll(async () => (await elements(guest)).length).toBe(1);
    await context.setOffline(true);
    await expect(guest.getByRole('status')).toContainText('Нет связи');
    await stroke(guest, 640, 350);
    await stroke(page, 550, 530);
    await context.setOffline(false);
    await ready(guest);
    await expect.poll(async () => (await elements(page)).length).toBe(3);
    await expect.poll(async () => (await elements(guest)).length).toBe(3);
    await guest.reload();
    await ready(guest);
    expect(await elements(guest)).toHaveLength(3);
  } finally {
    await context.close();
  }
});

test('select, duplicate, move, rotate, erase and Hand preserve expected objects', async ({
  page,
}) => {
  await create(page, 'Преобразования');
  await page.keyboard.down('KeyC');
  await stroke(page, 550, 380);
  await page.keyboard.up('KeyC');
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Select — выделение (V)', exact: true }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await elements(page)).length).toBe(2);
  const before = await elements(page);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await elements(page)).some((e, i) => e.x !== before[i].x))
    .toBeTruthy();
  const handle = await page.evaluate(() => {
    const api = window.__board.api;
    const state = api.getAppState();
    const e = api.getSceneElements().find((e) => state.selectedElementIds[e.id])!;
    return {
      id: e.id,
      x: (e.x + e.width / 2 + state.scrollX) * state.zoom.value + state.offsetLeft,
      y: (e.y + state.scrollY) * state.zoom.value + state.offsetTop - 20,
      cy: (e.y + e.height / 2 + state.scrollY) * state.zoom.value + state.offsetTop,
    };
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 100, handle.cy, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await elements(page)).find((e) => e.id === handle.id)!.angle)
    .not.toBe(0);
  await page.getByRole('button', { name: 'Hand — перемещение (H)', exact: true }).click();
  const original = await page.evaluate(() => window.__board.api.getAppState().scrollX);
  await stroke(page, 650, 550);
  await expect
    .poll(() => page.evaluate(() => window.__board.api.getAppState().scrollX))
    .not.toBe(original);
  expect(await elements(page)).toHaveLength(2);
  await page.getByRole('button', { name: 'Select — выделение (V)', exact: true }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await elements(page)).length).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await elements(page)).length).toBe(2);
});

test('laser pointer is visible to another browser, fades and works after reconnect and reload', async ({
  page,
  browser,
}) => {
  await create(page, 'Лазерная указка');
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guest = await context.newPage();

  async function redPixels(receiver: Page, point: { x: number; y: number }) {
    const clip = await receiver.evaluate(({ x, y }) => {
      const state = window.__board.api.getAppState();
      return {
        x: Math.round((x + state.scrollX) * state.zoom.value + state.offsetLeft) - 32,
        y: Math.round((y + state.scrollY) * state.zoom.value + state.offsetTop) - 32,
        width: 64,
        height: 64,
      };
    }, point);
    // Rasterize an actual browser screenshot: laser trails are in a separate overlay,
    // so checking only the scene or the static Canvas would miss this regression.
    // A participant's randomly colored cursor can also be red. Exclude just that
    // independent overlay so the assertion measures the actual laser trail.
    const screenshot = await receiver.screenshot({
      clip,
      style: '.remote-cursors { visibility: hidden !important; }',
    });
    return receiver.evaluate(async (base64) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 180 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
      return red;
    }, screenshot.toString('base64'));
  }

  async function pointLaser(sender: Page, receiver: Page) {
    if (await sender.evaluate(() => window.__board.api.getAppState().activeTool.type !== 'laser'))
      await sender.keyboard.press('k');
    await expect
      .poll(() => sender.evaluate(() => window.__board.api.getAppState().activeTool.type))
      .toBe('laser');
    const box = (await sender.getByTestId('drawing-surface').boundingBox())!;
    await sender.mouse.move(box.x + 480, box.y + 400);
    await sender.mouse.down();
    try {
      await sender.mouse.move(box.x + 650, box.y + 440, { steps: 20 });
      const pointer = await sender.evaluate(
        () =>
          window.__board.session.provider.awareness.getLocalState()!.pointer as {
            x: number;
            y: number;
          },
      );
      await expect.poll(() => redPixels(receiver, pointer), { timeout: 5000 }).toBeGreaterThan(3);
      await receiver.screenshot({ path: 'test-results/remote-laser.png' });
      return pointer;
    } finally {
      await sender.mouse.up();
    }
  }

  try {
    await guest.goto(url);
    await ready(guest);
    // The receiver's camera is independent; the trail must use scene coordinates.
    await guest.evaluate(() => {
      window.__board.api.updateScene({
        appState: { scrollX: 100, scrollY: 50, zoom: { value: 0.8 as AppState['zoom']['value'] } },
      });
    });
    // Older portions must survive many seconds and a brief lift between strokes.
    // Probe an early point away from the current head in BOTH independent clients.
    await page.keyboard.press('k');
    const box = (await page.getByTestId('drawing-surface').boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 300, { steps: 5 });
    const first = await page.evaluate(
      () => window.__board.session.provider.awareness.getLocalState()!.pointer,
    );
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 440 + i * 8, box.y + 300);
      await page.waitForTimeout(100);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    await page.mouse.move(box.x + 400, box.y + 420);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 400 + i * 8, box.y + 420);
      await page.waitForTimeout(100);
    }
    expect(await redPixels(page, first)).toBeGreaterThan(20);
    expect(await redPixels(guest, first)).toBeGreaterThan(20);
    await guest.screenshot({ path: 'test-results/retained-laser.png' });
    // Stopping movement also fades the drawing while the button remains held.
    await expect.poll(() => redPixels(page, first), { timeout: 5000 }).toBe(0);
    await expect.poll(() => redPixels(guest, first), { timeout: 5000 }).toBe(0);
    await page.mouse.up();
    const pointer = await pointLaser(page, guest);
    await expect.poll(() => redPixels(guest, pointer), { timeout: 5000 }).toBe(0);
    await page.getByRole('button', { name: 'Select — выделение (V)', exact: true }).click();
    await page.mouse.move(900, 700);
    await expect
      .poll(() =>
        guest.evaluate(
          () => [...window.__board.api.getAppState().collaborators.values()][0]?.pointer?.tool,
        ),
      )
      .toBe('pointer');
    await context.setOffline(true);
    await expect(guest.getByRole('status')).toContainText('Нет связи');
    await guest.keyboard.press('k');
    await stroke(guest, 480, 400);
    await context.setOffline(false);
    await ready(guest);
    await pointLaser(guest, page);
    await guest.reload();
    await ready(guest);
    await pointLaser(page, guest);
    await expect.poll(async () => (await elements(page)).length).toBe(0);
    expect(await elements(guest)).toHaveLength(0);
    expect(await page.evaluate(() => window.__board.session.doc.getMap('elements').size)).toBe(0);
  } finally {
    await context.close();
  }
});

test('catalog layout and narrow viewport stay usable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Мои доски' })).toBeVisible();
  await page.screenshot({ path: 'test-results/catalog.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Новая доска', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
});

test('eraser removes a stroke and undo brings it back', async ({ page }) => {
  await create(page, 'Ластик');
  await stroke(page, 500, 370);
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  await page.getByRole('button', { name: 'Eraser — ластик (E)', exact: true }).click();
  await page.mouse.move(box.x + 545, box.y + 395);
  await page.mouse.down();
  await page.mouse.move(box.x + 555, box.y + 405, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await elements(page)).length).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await elements(page)).length).toBe(1);
});

test('image upload is available to a fresh guest and no CDN is required', async ({
  page,
  browser,
}) => {
  const external: string[] = [];
  page.on('request', (req) => {
    if (/^https?:/.test(req.url()) && !req.url().startsWith('http://127.0.0.1:4310'))
      external.push(req.url());
  });
  await create(page, 'Картинка');
  const png = await page.screenshot({ clip: { x: 500, y: 350, width: 120, height: 80 } });
  const choosing = page.waitForEvent('filechooser', { timeout: 10000 });
  await page.getByRole('button', { name: 'Добавить изображение', exact: true }).click();
  const chooser = await choosing;
  await chooser.setFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.type === 'image').length)
    .toBe(1);
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(url);
    await ready(guest);
    await expect
      .poll(() => guest.evaluate(() => Object.keys(window.__board.api.getFiles()).length))
      .toBe(1);
    expect(
      await guest.evaluate(() => Object.values(window.__board.api.getFiles())[0].dataURL),
    ).toBe('data:image/png;base64,' + png.toString('base64'));
  } finally {
    await context.close();
  }
  expect(external).toEqual([]);
});

test('picture library inserts the cropped grid, supports undo and persists for a fresh guest', async ({
  page,
  browser,
}) => {
  await create(page, 'Координатная сетка');
  const library = page.getByRole('button', { name: 'Библиотека картинок', exact: true });
  await library.click();
  await expect(page.getByRole('heading', { name: 'Библиотека картинок' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await elements(page)).toHaveLength(0);
  await library.click();
  await page.screenshot({ path: 'test-results/image-library.png' });
  await page.getByRole('button', { name: 'Добавить: Координатная плоскость' }).click();
  await ready(page);
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  const grid = (await elements(page))[0];
  expect(grid.type).toBe('image');
  expect(grid.width).toBe(grid.height);
  expect(
    await page.evaluate((id) => !!window.__board.api.getAppState().selectedElementIds[id], grid.id),
  ).toBe(true);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await elements(page)).length).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  await ready(page);
  await page.reload();
  await ready(page);
  await expect.poll(async () => (await elements(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(url);
    await ready(guest);
    const expected =
      'data:image/png;base64,' + readFileSync('src/assets/coordinate-grid.png').toString('base64');
    await expect
      .poll(() => guest.evaluate(() => Object.values(window.__board.api.getFiles())[0]?.dataURL))
      .toBe(expected);
    await guest.getByRole('button', { name: 'Библиотека картинок', exact: true }).click();
    await guest.getByRole('button', { name: 'Добавить: Координатная плоскость' }).click();
    await ready(guest);
    await expect.poll(async () => (await elements(page)).length).toBe(2);
    await expect.poll(async () => (await elements(guest)).length).toBe(2);
    await guest.screenshot({ path: 'test-results/library-grid-on-board.png' });
  } finally {
    await context.close();
  }
});

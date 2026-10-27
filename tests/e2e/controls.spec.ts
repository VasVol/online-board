import { test, expect, type Page } from '@playwright/test';
import type { AppState } from '@excalidraw/excalidraw/types';
async function ready(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !!window.__board?.session.provider.synced))
    .toBeTruthy();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
}
async function create(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Общие инструменты');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForURL(/\/b\//);
  await ready(page);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return url;
}
async function addPage(page: Page) {
  const previous = new URL(page.url()).searchParams.get('page');
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Вторая');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).not.toBe(previous);
  await ready(page);
}
async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + dx, box.y + y + dy, { steps: 10 });
  await page.mouse.up();
}
async function gridPixels(page: Page) {
  return page.locator('canvas.excalidraw__canvas.static').evaluate((canvas: HTMLCanvasElement) => {
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const pixels = canvas
      .getContext('2d')!
      .getImageData(400 * ratio, 300 * ratio, 160 * ratio, 160 * ratio).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] > 100 && pixels[i] < 254 && pixels[i + 1] < 254 && pixels[i + 2] < 254)
        count++;
    return count;
  });
}
async function camera(page: Page) {
  return page.evaluate(() => {
    const s = window.__board.api.getAppState();
    return {
      x: s.width / (2 * s.zoom.value) - s.scrollX,
      y: s.height / (2 * s.zoom.value) - s.scrollY,
      zoom: s.zoom.value,
    };
  });
}
async function setCamera(page: Page, x: number, y: number, zoom: number) {
  await page.evaluate(
    ({ x, y, zoom }) =>
      window.__board.api.updateScene({
        appState: { scrollX: x, scrollY: y, zoom: { value: zoom as AppState['zoom']['value'] } },
      }),
    { x, y, zoom },
  );
}
async function sameCamera(a: Page, b: Page) {
  await expect
    .poll(async () => {
      const x = await camera(a),
        y = await camera(b);
      return Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.zoom - y.zoom));
    })
    .toBeLessThan(0.01);
}

test('persistent tools select once, draw repeatedly and ignore text fields', async ({ page }) => {
  await create(page);
  await page.keyboard.press('KeyL');
  await drag(page, 450, 300, 120, 60);
  await drag(page, 450, 390, 120, -40);
  expect(
    await page.evaluate(() => window.__board.api.getSceneElements().map((e) => e.type)),
  ).toEqual(['line', 'line']);
  await expect(page.getByRole('button', { name: 'Прямая (L)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('KeyC');
  for (const [dx, dy] of [
    [60, 30],
    [-60, 30],
    [-60, -30],
    [60, -30],
  ])
    await drag(page, 750, 450, dx, dy);
  const circles = await page.evaluate(() =>
    window.__board.api
      .getSceneElements()
      .filter((e) => e.type === 'ellipse')
      .map((e) => [e.width, e.height]),
  );
  expect(circles).toHaveLength(4);
  for (const [width, height] of circles) {
    expect(width).toBeGreaterThan(0);
    expect(width).toBe(height);
  }
  await expect(page.getByRole('button', { name: 'Окружность (C)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('p');
  await drag(page, 500, 530, 100, 40);
  await drag(page, 500, 600, 100, 40);
  expect(
    await page.evaluate(() =>
      window.__board.api
        .getSceneElements()
        .slice(-2)
        .map((e) => e.type),
    ),
  ).toEqual(['freedraw', 'freedraw']);
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('');
  await page.keyboard.press('KeyL');
  await page.keyboard.press('KeyC');
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue('lc');
  expect(await page.evaluate(() => window.__board.api.getAppState().activeTool.type)).toBe(
    'freedraw',
  );
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
});

test('shared grid reaches all pages and survives reload and reconnect', async ({
  page,
  browser,
}) => {
  const url = await create(page);
  const context = await browser.newContext();
  const guest = await context.newPage();
  try {
    await guest.goto(url);
    await ready(guest);
    await addPage(page);
    const grid = (p: Page) => p.getByRole('button', { name: 'Сетка', exact: true });
    await grid(page).click();
    await expect(grid(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(grid(guest)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => gridPixels(guest)).toBeGreaterThan(100);
    await guest.reload();
    await ready(guest);
    await expect(grid(guest)).toHaveAttribute('aria-pressed', 'true');
    await grid(guest).click();
    await expect(grid(page)).toHaveAttribute('aria-pressed', 'false');
    await context.setOffline(true);
    await expect(grid(guest)).toBeDisabled();
    await grid(page).click();
    await context.setOffline(false);
    await ready(guest);
    await expect(grid(guest)).toHaveAttribute('aria-pressed', 'true');
    await guest.screenshot({ path: 'test-results/shared-grid.png' });
    await grid(guest).click();
    await expect(grid(page)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => gridPixels(page)).toBe(0);
  } finally {
    await context.close();
  }
});

test('owner gathers participants across pages once without permanent following', async ({
  page,
  browser,
}) => {
  const url = await create(page);
  const firstUrl = page.url();
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const guest = await context.newPage();
  const second = await browser.newContext();
  const other = await second.newPage();
  try {
    await guest.goto(url);
    await ready(guest);
    await expect(guest.getByRole('button', { name: 'Собрать всех', exact: true })).toHaveCount(0);
    await drag(guest, 470, 350, 100, 50);
    await expect(guest.getByRole('status')).toHaveText('Сохранено');
    await addPage(page);
    const targetUrl = page.url();
    await other.goto(targetUrl + new URL(url).hash);
    await ready(other);
    await setCamera(page, -1800, 930, 1.6);
    await other.locator('.UserList .Avatar').first().click();
    await sameCamera(page, other);
    await page.getByRole('button', { name: 'Собрать всех', exact: true }).click();
    await expect
      .poll(() => new URL(guest.url()).searchParams.get('page'))
      .toBe(new URL(targetUrl).searchParams.get('page'));
    await ready(guest);
    await sameCamera(page, guest);
    await sameCamera(page, other);
    await expect(other.locator('.follow-mode')).toHaveCount(0);
    // Independent movement is preserved after the one-shot jump.
    await setCamera(guest, 400, -230, 0.7);
    const independent = await camera(guest);
    await setCamera(page, 600, 700, 2);
    await guest.waitForTimeout(250);
    expect(await camera(guest)).toEqual(independent);
    // Returning to the old page preserves drawings; returning again does not replay the jump.
    await guest.goto(firstUrl + new URL(url).hash);
    await ready(guest);
    expect(await guest.evaluate(() => window.__board.api.getSceneElements().length)).toBe(1);
    await guest.goto(targetUrl + new URL(url).hash);
    await ready(guest);
    expect((await camera(guest)).zoom).toBe(1);
    await page.getByRole('button', { name: 'Собрать всех', exact: true }).click();
    await sameCamera(page, guest);
    // A newly connected participant is not pulled by an old command.
    const late = await context.newPage();
    await late.goto(url);
    await ready(late);
    expect(new URL(late.url()).searchParams.get('page')).toBe(
      new URL(firstUrl).searchParams.get('page'),
    );
    await guest.screenshot({ path: 'test-results/gathered-participant.png' });
  } finally {
    await context.close();
    await second.close();
  }
});

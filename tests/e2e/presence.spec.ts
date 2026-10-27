import { followFirstParticipant } from './collaborators';
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
  await page.getByLabel('Название', { exact: true }).fill('Курсоры и following');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForURL(/\/b\//);
  await ready(page);
}
async function camera(page: Page) {
  return page.evaluate(() => {
    const s = window.__board.api.getAppState();
    return {
      zoom: s.zoom.value,
      x: s.width / (2 * s.zoom.value) - s.scrollX,
      y: s.height / (2 * s.zoom.value) - s.scrollY,
    };
  });
}
async function setCamera(page: Page, x: number, y: number, zoom: number) {
  await page.evaluate(
    ({ x, y, zoom }) => {
      window.__board.api.updateScene({
        appState: { scrollX: x, scrollY: y, zoom: { value: zoom as AppState['zoom']['value'] } },
      });
    },
    { x, y, zoom },
  );
}
async function sameCamera(a: Page, b: Page) {
  await expect
    .poll(
      async () => {
        const first = await camera(a),
          second = await camera(b);
        return Math.max(
          Math.abs(first.x - second.x),
          Math.abs(first.y - second.y),
          Math.abs(first.zoom - second.zoom),
        );
      },
      { timeout: 5000 },
    )
    .toBeLessThan(0.01);
}

test('following matches zoom and center across independent browsers', async ({ page, browser }) => {
  await page.addInitScript(() => {
    if (location.origin !== 'null') localStorage.setItem('pole-name', 'Ведущий');
  });
  await create(page);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  await context.addInitScript(() => {
    if (location.origin !== 'null') localStorage.setItem('pole-name', 'Зритель');
  });
  const guest = await context.newPage();
  try {
    await guest.goto(url);
    await ready(guest);
    await expect(guest.locator('.UserList__more')).toBeVisible();
    await setCamera(page, 210, -180, 1.7);
    await followFirstParticipant(guest);
    await expect(guest.locator('.follow-mode')).toContainText('Ведущий');
    await sameCamera(page, guest);
    // Leader pans with the real Hand tool, then changes zoom independently.
    await page.getByRole('button', { name: 'Hand — перемещение (H)', exact: true }).click();
    const box = (await page.getByTestId('drawing-surface').boundingBox())!;
    await page.mouse.move(box.x + 500, box.y + 380);
    await page.mouse.down();
    await page.mouse.move(box.x + 670, box.y + 450, { steps: 15 });
    await page.mouse.up();
    await sameCamera(page, guest);
    await setCamera(page, -320, 260, 0.65);
    await sameCamera(page, guest);
    await guest.setViewportSize({ width: 1100, height: 720 });
    await sameCamera(page, guest);
    await guest.setViewportSize({ width: 1300, height: 900 });
    await sameCamera(page, guest);

    // Closing following leaves a genuinely independent camera.
    await guest.locator('.follow-mode__disconnect-btn').click();
    await expect(guest.locator('.follow-mode')).toHaveCount(0);
    const stopped = await camera(guest);
    await setCamera(page, 900, 400, 2);
    await guest.waitForTimeout(250);
    expect(await camera(guest)).toEqual(stopped);
    await followFirstParticipant(guest);
    await sameCamera(page, guest);

    // An offline follower stops following and can follow again after reconnect.
    await context.setOffline(true);
    await expect(guest.getByRole('status')).toContainText('Нет связи');
    await expect(guest.locator('.follow-mode')).toHaveCount(0);
    await context.setOffline(false);
    await ready(guest);
    await expect(guest.locator('.UserList .Avatar, .UserList__more').first()).toBeVisible({
      timeout: 3000,
    });
    await followFirstParticipant(guest);
    await sameCamera(page, guest);
    // A leader leaving the page also stops the viewer's following.
    await page.goto('/');
    await expect(guest.locator('.follow-mode')).toHaveCount(0);
    await page.goto(url);
    await ready(page);
    await followFirstParticipant(guest);
    await sameCamera(page, guest);
    await guest.reload();
    await ready(guest);
    await expect(guest.locator('.follow-mode')).toHaveCount(0);
    await followFirstParticipant(guest);
    await sameCamera(page, guest);

    // Attempting to follow one's own follower must not create a camera loop.
    await followFirstParticipant(page);
    await expect
      .poll(async () => {
        const a = await page.evaluate(() => window.__board.api.getAppState().userToFollow);
        const b = await guest.evaluate(() => window.__board.api.getAppState().userToFollow);
        return !!a && !!b;
      })
      .toBe(false);
    expect(await page.evaluate(() => window.__board.session.doc.getMap('elements').size)).toBe(0);
  } finally {
    await context.close();
  }
});

test('cursor labels are off by default and can be toggled without hiding participants', async ({
  page,
  browser,
}) => {
  await create(page);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const first = await browser.newContext();
  const second = await browser.newContext();
  await first.addInitScript(() => {
    if (location.origin !== 'null') localStorage.setItem('pole-name', 'Анна');
  });
  await second.addInitScript(() => {
    if (location.origin !== 'null') localStorage.setItem('pole-name', 'Борис');
  });
  try {
    const a = await first.newPage(),
      b = await second.newPage();
    await a.goto(url);
    await b.goto(url);
    await ready(a);
    await ready(b);
    for (const [guest, x] of [
      [a, 450],
      [b, 650],
    ] as const) {
      const box = (await guest.getByTestId('drawing-surface').boundingBox())!;
      await guest.mouse.move(box.x + x, box.y + 350);
    }
    await expect(page.locator('.remote-cursor')).toHaveCount(2);
    await expect(page.locator('.remote-cursor-name')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Подписи курсоров', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    const colors = await page
      .locator('.remote-cursor')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
    expect(new Set(colors).size).toBe(2);
    expect(
      await page.evaluate(() =>
        [...window.__board.api.getAppState().collaborators.values()].map((c) => c.username).sort(),
      ),
    ).toEqual(['Анна', 'Борис']);
    expect(
      await page.evaluate(() =>
        [...window.__board.api.getAppState().collaborators.values()].every(
          (c) => c.pointer?.renderCursor === false,
        ),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Подписи курсоров', exact: true }).click();
    await expect
      .poll(async () => (await page.locator('.remote-cursor-name').allTextContents()).sort())
      .toEqual(['Анна', 'Борис']);
    await expect(page.locator('.remote-cursor-name').first()).toBeVisible();
    // This preference is local: other viewers still have no labels.
    await expect(a.locator('.remote-cursor-name')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/cursor-labels-on.png' });
    await page.getByRole('button', { name: 'Подписи курсоров', exact: true }).click();
    await expect(page.locator('.remote-cursor-name')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/cursor-labels-off.png' });
    await setCamera(page, 120, -40, 0.8);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__board.api.getAppState();
          const [id, peer] = [...window.__board.session.provider.awareness.getStates()].find(
            ([, value]) => value.name === 'Анна',
          )!;
          const cursor = document.querySelector(`[data-client="${id}"]`)!.getBoundingClientRect();
          return Math.max(
            Math.abs(
              cursor.x - ((peer.pointer.x + state.scrollX) * state.zoom.value + state.offsetLeft),
            ),
            Math.abs(
              cursor.y - ((peer.pointer.y + state.scrollY) * state.zoom.value + state.offsetTop),
            ),
          );
        }),
      )
      .toBeLessThan(0.1);
    await page.reload();
    await ready(page);
    await expect(
      page.getByRole('button', { name: 'Подписи курсоров', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await first.close();
    await expect(page.locator('.remote-cursor')).toHaveCount(1);
  } finally {
    await first.close();
    await second.close();
  }
});

test('new rectangles diamonds and polygons have sharp corners by default', async ({ page }) => {
  await create(page);
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  for (const [key, y] of [
    ['r', 300],
    ['d', 470],
  ] as const) {
    await page.keyboard.press(key);
    await page.mouse.move(box.x + 450, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 580, box.y + y + 100, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.__board.api.setActiveTool({ type: 'line' }));
  await page.mouse.click(box.x + 700, box.y + 300);
  await page.mouse.click(box.x + 850, box.y + 300);
  await page.mouse.click(box.x + 800, box.y + 450);
  await page.mouse.click(box.x + 700, box.y + 300);
  await page.keyboard.press('Escape');
  const shapes = await page.evaluate(() =>
    window.__board.api.getSceneElements().map((e) => ({ type: e.type, roundness: e.roundness })),
  );
  expect(shapes).toEqual([
    { type: 'rectangle', roundness: null },
    { type: 'diamond', roundness: null },
    { type: 'line', roundness: null },
  ]);
  await page.screenshot({ path: 'test-results/sharp-corners.png' });
  // Explicit rounding remains available and must survive reload unchanged.
  await page.evaluate(() => {
    window.__board.api.updateScene({ appState: { currentItemRoundness: 'round' } });
    window.__board.api.setActiveTool({ type: 'rectangle' });
  });
  await page.mouse.move(box.x + 700, box.y + 520);
  await page.mouse.down();
  await page.mouse.move(box.x + 850, box.y + 620, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__board.api.getSceneElements().at(-1)?.roundness))
    .not.toBeNull();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await page.reload();
  await ready(page);
  expect(await page.evaluate(() => window.__board.api.getAppState().currentItemRoundness)).toBe(
    'sharp',
  );
  expect(
    await page.evaluate(() => window.__board.api.getSceneElements().at(-1)?.roundness),
  ).not.toBeNull();
});

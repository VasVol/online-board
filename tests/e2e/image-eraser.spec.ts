import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function ready(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !!window.__board?.session.provider.synced))
    .toBeTruthy();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
}
async function scene(page: Page) {
  return page.evaluate(() => window.__board.api.getSceneElements());
}
async function imagePoint(page: Page) {
  return page.evaluate(() => {
    const image = window.__board.api.getSceneElements().find((e) => e.type === 'image')!;
    const s = window.__board.api.getAppState();
    return {
      x: (image.x + image.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft,
      y: (image.y + image.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop,
    };
  });
}
async function tool(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
}
async function erase(page: Page) {
  await tool(page, 'Eraser — ластик (E)');
  const p = await imagePoint(page);
  await page.mouse.move(p.x - 25, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 25, p.y, { steps: 8 });
  // Check during the gesture: no image tombstone or temporary lock reaches Yjs.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...window.__board.session.doc.getMap('elements').values()]
          .filter((e: any) => e.type === 'image')
          .every((e: any) => !e.isDeleted && !e.locked),
      ),
    )
    .toBe(true);
  await page.mouse.up();
  await expect
    .poll(async () => (await scene(page)).filter((e) => e.type === 'image').every((e) => !e.locked))
    .toBe(true);
}

for (const source of ['clipboard', 'upload', 'library'] as const) {
  test(`image eraser protection: ${source}, movement, explicit deletion, history and peers`, async ({
    page,
    context,
    browser,
  }) => {
    await context.addInitScript(() => {
      delete (window as any).BroadcastChannel;
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill('Защита картинки');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForURL(/\/b\//);
    await ready(page);
    if (source === 'library') {
      await tool(page, 'Библиотека картинок');
      await page.getByRole('button', { name: 'Добавить: Координатная плоскость' }).click();
    } else if (source === 'upload') {
      await page.getByTestId('image-upload').setInputFiles('src/assets/coordinate-grid.png');
    } else {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const data =
        'data:image/png;base64,' +
        readFileSync('src/assets/coordinate-grid.png').toString('base64');
      await page.evaluate(async (url) => {
        const blob = await (await fetch(url)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }, data);
      await tool(page, 'Select — выделение (V)');
      const box = (await page.getByTestId('drawing-surface').boundingBox())!;
      await page.mouse.click(box.x + 700, box.y + 400);
      await page.keyboard.press('Control+v');
    }
    await expect.poll(async () => (await scene(page)).length).toBe(1);
    await ready(page);
    const image = (await scene(page))[0];
    await tool(page, 'Поделиться');
    const url = await page.getByLabel('Ссылка для редактирования').inputValue();
    await page.keyboard.press('Escape');
    const guestContext = await browser.newContext();
    await guestContext.addInitScript(() => {
      delete (window as any).BroadcastChannel;
    });
    const guest = await guestContext.newPage();
    try {
      await guest.goto(url);
      await ready(guest);
      await expect.poll(async () => (await scene(guest)).length).toBe(1);
      await tool(page, 'Draw — карандаш (P)');
      const p = await imagePoint(page);
      await page.mouse.move(p.x, p.y - 60);
      await page.mouse.down();
      await page.mouse.move(p.x, p.y + 60, { steps: 12 });
      await page.mouse.up();
      await expect.poll(async () => (await scene(guest)).length).toBe(2);
      await erase(page);
      await expect.poll(async () => (await scene(page)).map((e) => e.type)).toEqual(['image']);
      await expect.poll(async () => (await scene(guest)).map((e) => e.type)).toEqual(['image']);
      // Undo/redo while the eraser is still active must only affect the writing.
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await scene(page)).length).toBe(2);
      await page.keyboard.press('Control+Shift+z');
      await expect.poll(async () => (await scene(page)).map((e) => e.type)).toEqual(['image']);
      await expect.poll(async () => (await scene(guest)).length).toBe(1);
      expect((await scene(page))[0]).toEqual(image);
      // A click (without dragging) is another SDK eraser path.
      await page.mouse.click(p.x, p.y);
      expect((await scene(page))[0]).toEqual(image);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await scene(page)).length).toBe(2);
      await page.keyboard.press('Control+Shift+z');
      await expect.poll(async () => (await scene(page)).length).toBe(1);
      await tool(page, 'Select — выделение (V)');
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 70, p.y + 30, { steps: 10 });
      await page.mouse.up();
      await expect.poll(async () => (await scene(page))[0]?.x).toBeCloseTo(image.x + 70);
      await expect.poll(async () => (await scene(guest))[0]?.x).toBeCloseTo(image.x + 70);
      await ready(page);
      await page.reload();
      await ready(page);
      await guestContext.setOffline(true);
      await erase(guest);
      expect((await scene(guest))[0].type).toBe('image');
      await guestContext.setOffline(false);
      await ready(guest);
      await erase(page);
      await tool(page, 'Select — выделение (V)');
      const moved = await imagePoint(page);
      await page.mouse.click(moved.x, moved.y);
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await scene(page)).length).toBe(0);
      // Remote deliberate deletion must work even when the viewer has eraser selected.
      await expect.poll(async () => (await scene(guest)).length).toBe(0);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await scene(page)).length).toBe(1);
      await page.mouse.click(moved.x, moved.y);
      await page.keyboard.press('Backspace');
      await expect.poll(async () => (await scene(guest)).length).toBe(0);
      await ready(page);
      await guest.reload();
      await ready(guest);
      expect(await scene(guest)).toHaveLength(0);
    } finally {
      await guestContext.close();
    }
  });
}

test('image eraser protection: groups, frames, cancelled gesture and insertion undo', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Группа с картинкой');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForURL(/\/b\//);
  await ready(page);
  await tool(page, 'Библиотека картинок');
  await page.getByRole('button', { name: 'Добавить: Координатная плоскость' }).click();
  await expect.poll(async () => (await scene(page)).length).toBe(1);
  await erase(page);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await scene(page)).length).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await scene(page)).length).toBe(1);
  await tool(page, 'Draw — карандаш (P)');
  const p = await imagePoint(page);
  await page.mouse.move(p.x, p.y - 50);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 50, { steps: 10 });
  await page.mouse.up();
  await tool(page, 'Select — выделение (V)');
  await page.mouse.click(p.x + 300, p.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');
  await expect
    .poll(async () => (await scene(page)).every((e) => e.groupIds.length === 1))
    .toBe(true);
  const image = (await scene(page)).find((e) => e.type === 'image')!;
  await erase(page);
  await expect.poll(async () => (await scene(page)).map((e) => e.type)).toEqual(['image']);
  expect((await scene(page))[0]).toEqual(image);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await scene(page)).length).toBe(2);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await scene(page)).length).toBe(1);
  // Browser cancellation must not leave the local image locked.
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page
    .locator('canvas.excalidraw__canvas.interactive')
    .dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await scene(page))[0]?.locked).toBe(false);
  await tool(page, 'Select — выделение (V)');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await scene(page)).length).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await scene(page)).length).toBe(1);
  await page.keyboard.press('Control+Shift+g');
  await page.keyboard.press('KeyF');
  await page.mouse.move(p.x - 270, p.y - 270);
  await page.mouse.down();
  await page.mouse.move(p.x + 270, p.y + 270, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await scene(page)).find((e) => e.type === 'image')?.frameId)
    .toBeTruthy();
  await tool(page, 'Eraser — ластик (E)');
  await page.mouse.move(p.x, p.y - 275);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y - 265, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await scene(page)).map((e) => e.type)).toEqual(['image']);
  await ready(page);
  await page.reload();
  await ready(page);
  await expect.poll(async () => (await scene(page)).map((e) => e.type)).toEqual(['image']);
});

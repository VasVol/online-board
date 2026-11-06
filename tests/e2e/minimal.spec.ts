import { test, expect, type Page } from '@playwright/test';

async function create(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Минимальный интерфейс');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await expect.poll(() => page.evaluate(() => !!window.__board?.api)).toBe(true);
}

test('minimal interface keeps palette fixed, exposes extra tools and protects the default zoom', async ({
  page,
}) => {
  await create(page);
  const palette = page.getByRole('group', { name: 'Цвет пера', exact: true });
  const position = await palette.boundingBox();
  await expect(palette.getByRole('button')).toHaveCount(12);
  await expect(page.locator('.excalidraw .App-toolbar-container')).toBeHidden();
  await expect(page.locator('.pages-list')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__board.api.getAppState();
        return [state.zoom.value, state.currentItemStrokeWidth, state.gridModeEnabled];
      }),
    )
    .toEqual([1, 4, false]);
  for (const name of [
    'Цвет: Синий',
    'Прямая (L)',
    'Окружность (C)',
    'Указка (K)',
    'Draw — карандаш (P)',
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await palette.boundingBox()).toEqual(position);
  }
  await page.mouse.move(640, 420);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -650);
  await page.keyboard.up('Control');
  // Wheel processing is asynchronous in Chromium.
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__board.api.getAppState().zoom.value)).toBe(1);
  await page.mouse.down();
  await page.mouse.move(800, 460, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__board.api.getSceneElements().length))
    .toBe(1);
  expect(await page.evaluate(() => window.__board.api.getSceneElements()[0])).toMatchObject({
    strokeColor: '#4465ed',
    strokeWidth: 4,
  });
  await page.getByRole('button', { name: 'Ещё', exact: true }).click();
  await expect(page.getByLabel('Стиль пера', { exact: true })).toHaveValue('solid');
  await expect(page.getByRole('group', { name: 'Быстрый выбор толщины' })).toHaveCount(0);
  const width = page.getByRole('combobox', { name: 'Толщина пера', exact: true });
  await expect(width).toHaveValue('4');
  await expect(width.locator('option')).toHaveText(
    Array.from({ length: 10 }, (_, i) => `${i + 1} px`),
  );
  await width.selectOption('7');
  await expect
    .poll(() => page.evaluate(() => window.__board.api.getAppState().currentItemStrokeWidth))
    .toBe(7);

  await expect(page.getByRole('button', { name: 'Подписи курсоров', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Все инструменты', exact: true }).click();
  await expect(page.locator('.excalidraw .App-toolbar-container')).toBeVisible();
  expect(await palette.boundingBox()).toEqual(position);
  await page.getByRole('button', { name: 'Все инструменты', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Ещё', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Страницы', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Страницы доски' })).toBeVisible();
  expect(await palette.boundingBox()).toEqual(position);
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Вторая');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await expect
    .poll(() => page.evaluate(() => window.__board.api.getSceneElements().length))
    .toBe(0);
  expect(await palette.boundingBox()).toEqual(position);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  expect(await page.evaluate(() => window.__board.api.getAppState().zoom.value)).toBe(1);
  await page.screenshot({ path: 'test-results/minimal-desktop.png' });
});

test('minimal interface fits a narrow screen and retains PNG SVG and JSON exports', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await create(page);
  await page.mouse.move(170, 500);
  await page.mouse.down();
  await page.mouse.move(280, 550, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await page.getByRole('button', { name: 'Ещё', exact: true }).click();
  const menu = await page.locator('.dock-more .popover-content').boundingBox();
  expect(menu!.x).toBeGreaterThan(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  expect(menu!.y + menu!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  for (const [label, extension] of [
    ['Скачать PNG', '.png'],
    ['Скачать SVG', '.svg'],
    ['Скачать .excalidraw', '.excalidraw'],
  ]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toContain(extension);
    expect(await file.failure()).toBeNull();
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBeGreaterThan(100);
    if (extension === '.svg') expect(bytes.toString()).toContain('<svg');
    if (extension === '.excalidraw') expect(JSON.parse(bytes.toString()).elements).toHaveLength(1);
  }
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/minimal-mobile.png' });
});

test('minimal interface page rows rename on double click and delete only the confirmed page', async ({
  page,
  browser,
}) => {
  await create(page);
  const picker = page.getByRole('button', { name: 'Страницы', exact: true });
  const list = page.getByRole('navigation', { name: 'Страницы доски' });
  const name = page.getByLabel('Название', { exact: true });
  async function openPages() {
    if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  }
  for (const title of ['Вторая', 'Третья']) {
    await openPages();
    await expect(page.getByRole('button', { name: 'Новая страница', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
    await name.fill(title);
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(picker).toContainText(title);
    await expect(page.getByRole('status')).toHaveText('Сохранено');
  }
  const thirdUrl = page.url();
  await openPages();
  await expect(page.getByRole('button', { name: 'Название страницы', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Удалить страницу', exact: true })).toHaveCount(0);
  await list.getByRole('button', { name: '1 Страница 1', exact: true }).dblclick();
  await expect(page.getByRole('dialog', { name: 'Название страницы', exact: true })).toBeVisible();
  await expect(name).toHaveValue('Страница 1');
  await name.fill('Первая — переименована');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(picker).toContainText('Первая — переименована');
  await openPages();
  await list.getByRole('button', { name: '3 Третья', exact: true }).click();
  await expect(picker).toContainText('Третья');
  await expect(page).toHaveURL(thirdUrl);
  await expect(list).toBeVisible();
  const trash = page.getByRole('button', {
    name: 'Удалить страницу «Первая — переименована»',
    exact: true,
  });
  await page.mouse.move(700, 600);
  await expect(trash).toHaveCSS('opacity', '0');
  await list.getByRole('button', { name: '1 Первая — переименована', exact: true }).hover();
  await expect(trash).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/minimal-pages.png' });
  await trash.click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить страницу?', exact: true });
  await expect(confirmation).toContainText('Первая — переименована');
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page).toHaveURL(thirdUrl);
  await openPages();
  await expect(list.locator('.page-row')).toHaveCount(3);
  await list.getByRole('button', { name: '1 Первая — переименована', exact: true }).hover();
  await trash.click();
  await confirmation.getByRole('button', { name: 'Удалить страницу', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page).toHaveURL(thirdUrl);
  await expect(picker).toContainText('Третья');
  await openPages();
  await expect(list.locator('.page-row')).toHaveCount(2);
  // Deleting the open page under a search filter still finds the surviving page.
  await page.getByRole('textbox', { name: 'Поиск страниц' }).fill('Третья');
  await expect(list.locator('.page-row')).toHaveCount(1);
  await list.getByRole('button', { name: '1 Третья', exact: true }).hover();
  await page.getByRole('button', { name: 'Удалить страницу «Третья»', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить страницу', exact: true }).click();
  await expect(picker).toContainText('Вторая');
  await expect(page.getByRole('status')).toHaveText('Сохранено');
  await openPages();
  await list.getByRole('button', { name: '1 Вторая', exact: true }).hover();
  await page.getByRole('button', { name: 'Удалить страницу «Вторая»', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить страницу', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toHaveText('Нельзя удалить последнюю страницу');
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.reload();
  await expect(picker).toContainText('Вторая');
  await openPages();
  await expect(list.locator('.page-row')).toHaveCount(1);
  await list.getByRole('button', { name: '1 Вторая', exact: true }).focus();
  await page.keyboard.press('F2');
  await expect(name).toHaveValue('Вторая');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(url);
    await expect(guest.getByRole('status')).toHaveText('Сохранено');
    await guest.getByRole('button', { name: 'Страницы', exact: true }).click();
    await expect(guest.locator('.page-delete')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Новая страница', exact: true })).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

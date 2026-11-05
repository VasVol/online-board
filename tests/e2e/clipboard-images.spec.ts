import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !!window.__board?.session.provider.synced))
    .toBeTruthy();
  await expect(page.getByRole('status')).toHaveText('Сохранено');
}
async function create(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая доска', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Синтетическая проверка буфера');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForURL(/\/b\//);
  await ready(page);
}
async function count(page: Page) {
  return page.evaluate(() => window.__board.api.getSceneElements().length);
}
async function paste(page: Page, dataURL: string) {
  await page.bringToFront();
  await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }, dataURL);
  await page.getByRole('button', { name: 'Select — выделение (V)', exact: true }).click();
  const box = (await page.getByTestId('drawing-surface').boundingBox())!;
  await page.mouse.click(box.x + 700, box.y + 400);
  await page.keyboard.press('Control+v');
}
async function file(page: Page) {
  return page.evaluate(() => {
    const image = [...window.__board.api.getSceneElements()]
      .reverse()
      .find((e) => e.type === 'image');
    return image?.type === 'image' && image.fileId
      ? window.__board.api.getFiles()[image.fileId]
      : undefined;
  });
}
async function pixelsVisible(page: Page) {
  return page.evaluate(() => {
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
      'canvas.excalidraw__canvas',
    )) {
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let red = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90 && data[i + 3] > 100) red++;
      if (red > 2000) return true;
    }
    return false;
  });
}
async function photo(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 960;
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 42;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 190 + ((seed >>> 24) % 60);
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.font = '22px serif';
    ctx.fillStyle = '#111';
    for (let y = 60; y < 960; y += 45)
      ctx.fillText('x² + y² = 25; (a + b)(a - b) = a² - b²; 1/2 + 1/3 = 5/6', 40, y);
    ctx.fillStyle = '#e03131';
    ctx.fillRect(800, 600, 300, 240);
    const jpeg = canvas.toDataURL('image/jpeg', 0.735);
    const image = new Image();
    image.src = jpeg;
    await image.decode();
    ctx.drawImage(image, 0, 0);
    return { jpeg, png: canvas.toDataURL('image/png') };
  });
}

test('clipboard images: photo stays readable, smaller, synced and durable across reconnect', async ({
  page,
  context,
  browser,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await create(page);
  const source = await photo(page);
  const puts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && /\/files\//.test(request.url()))
      puts.push(JSON.parse(request.postData()!).dataURL);
  });
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const url = await page.getByLabel('Ссылка для редактирования').inputValue();
  await page.keyboard.press('Escape');
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(url);
    await ready(guest);
    await paste(page, source.png);
    await expect.poll(() => count(page)).toBe(1);
    await ready(page);
    await expect.poll(async () => (await file(guest))?.mimeType).toBe('image/webp');
    const saved = (await file(page))!;
    expect(saved.mimeType).toBe('image/webp');
    expect(saved.dataURL.length).toBeLessThan(source.png.length * 0.55);
    expect(puts).toContain(saved.dataURL);
    expect((await file(guest))?.dataURL).toBe(saved.dataURL);
    await expect.poll(() => pixelsVisible(guest)).toBeTruthy();
    await expect.poll(() => pixelsVisible(page)).toBeTruthy();
    const fidelity = await page.evaluate(
      async ({ original, converted }) => {
        const decode = async (url: string) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          return {
            width: canvas.width,
            height: canvas.height,
            pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          };
        };
        const a = await decode(original),
          b = await decode(converted);
        let error = 0,
          darkPixels = 0;
        for (let i = 0; i < a.pixels.length; i += 4)
          if (a.pixels[i] < 70 && a.pixels[i + 1] < 70 && a.pixels[i + 2] < 70) {
            error += Math.abs(a.pixels[i] - b.pixels[i]);
            darkPixels++;
          }
        return { width: b.width, height: b.height, darkPixels, meanTextError: error / darkPixels };
      },
      { original: source.png, converted: saved.dataURL },
    );
    expect(fidelity).toMatchObject({ width: 1280, height: 960 });
    expect(fidelity.darkPixels).toBeGreaterThan(10000);
    expect(fidelity.meanTextError).toBeLessThan(4);
    await page.screenshot({ path: testInfo.outputPath('clipboard-photo.png') });
    console.log('Clipboard photo bytes and text error:', {
      jpeg: Buffer.from(source.jpeg.split(',')[1], 'base64').length,
      png: Buffer.from(source.png.split(',')[1], 'base64').length,
      webp: Buffer.from(saved.dataURL.split(',')[1], 'base64').length,
      ...fidelity,
    });
    await page.keyboard.press('Control+z');
    await expect.poll(() => count(page)).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => count(page)).toBe(1);
    await context.setOffline(true);
    await paste(page, source.png);
    await expect.poll(() => count(page)).toBe(2);
    await expect(page.getByRole('status')).not.toHaveText('Сохранено');
    await context.setOffline(false);
    await ready(page);
    await expect.poll(() => count(guest)).toBe(2);
    await expect
      .poll(() => guest.evaluate(() => Object.keys(window.__board.api.getFiles()).length))
      .toBe(2);
    await page.reload();
    await ready(page);
    await expect.poll(async () => (await file(page))?.dataURL === saved.dataURL).toBe(true);
    await guestContext.clearCookies();
    const freshContext = await browser.newContext();
    try {
      const fresh = await freshContext.newPage();
      await fresh.goto(url);
      await ready(fresh);
      await expect.poll(async () => (await file(fresh))?.dataURL).toBe(saved.dataURL);
      await expect.poll(() => pixelsVisible(fresh)).toBeTruthy();
    } finally {
      await freshContext.close();
    }
  } finally {
    await guestContext.close();
  }
});

test('clipboard images: alpha and fine ink are lossless, internal copying and JPEG upload keep bytes', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await create(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 960;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(canvas.width, canvas.height);
    let seed = 17;
    for (let i = 0; i < data.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if ((seed >>> 24) % 7 === 0) {
        data.data[i] = data.data[i + 1] = data.data[i + 2] = 0;
        data.data[i + 3] = seed & 1 ? 128 : 255;
      }
    }
    ctx.putImageData(data, 0, 0);
    ctx.font = '22px serif';
    ctx.fillStyle = '#000';
    ctx.fillText('1/2 + 1/3 = 5/6; x² + y² = 25', 100, 100);
    return canvas.toDataURL('image/png');
  });
  expect(Buffer.from(png.split(',')[1], 'base64').length).toBeGreaterThan(128 * 1024);
  await paste(page, png);
  await expect.poll(() => count(page)).toBe(1);
  await ready(page);
  const saved = (await file(page))!;
  expect(saved.mimeType).toBe('image/webp');
  expect(
    await page.evaluate(
      async ({ original, converted }) => {
        const decode = async (url: string) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const a = await decode(original),
          b = await decode(converted);
        return a.length === b.length && a.every((value, index) => value === b[index]);
      },
      { original: png, converted: saved.dataURL },
    ),
  ).toBe(true);
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('excalidraw/clipboard');
  await page.keyboard.press('Control+v');
  await expect.poll(() => count(page)).toBe(2);
  expect(await page.evaluate(() => Object.keys(window.__board.api.getFiles()).length)).toBe(1);
  // Simulate a browser whose quality=1 encoder is lossy: pixel verification must reject it.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      return original.call(this, callback, type, type === 'image/webp' ? 0.5 : quality);
    };
  });
  const colored = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = '#d02612';
    ctx.fillRect(300, 300, 200, 200);
    return canvas.toDataURL('image/png');
  }, png);
  await paste(page, colored);
  await expect.poll(() => count(page)).toBe(3);
  await ready(page);
  expect((await file(page))?.mimeType).toBe('image/png');
  const source = await photo(page);
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Добавить изображение', exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: 'source.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(source.jpeg.split(',')[1], 'base64'),
  });
  await expect.poll(() => count(page)).toBe(4);
  await ready(page);
  expect((await file(page))?.dataURL === source.jpeg).toBe(true);
});

test('clipboard images: pending conversion is visible and cancelled on page change; text inputs keep native paste', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await create(page);
  const source = await photo(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (type !== 'image/webp') return original.call(this, callback, type, quality);
      (window as unknown as { finishImage: () => Promise<void> }).finishImage = () =>
        new Promise((resolve) => {
          original.call(
            this,
            (blob) => {
              callback(blob);
              resolve();
            },
            type,
            quality,
          );
        });
    };
  });
  let uploads = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && /\/files\//.test(request.url())) uploads++;
  });
  await paste(page, source.png);
  await expect.poll(() => page.evaluate(() => 'finishImage' in window)).toBe(true);
  await expect(page.getByRole('status')).toHaveText('Сохраняем…');
  expect(await count(page)).toBe(0);
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  const name = page.getByLabel('Название', { exact: true });
  await name.fill('');
  await page.evaluate(() => navigator.clipboard.writeText('Текст из буфера'));
  await name.focus();
  await page.keyboard.press('Control+v');
  await expect(name).toHaveValue('Текст из буфера');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await ready(page);
  await page.evaluate(() =>
    (window as unknown as { finishImage: () => Promise<void> }).finishImage(),
  );
  expect(await count(page)).toBe(0);
  await page
    .getByRole('navigation', { name: 'Страницы доски' })
    .getByRole('button', { name: '1 Страница 1' })
    .click();
  await ready(page);
  expect(await count(page)).toBe(0);
  expect(uploads).toBe(0);
});

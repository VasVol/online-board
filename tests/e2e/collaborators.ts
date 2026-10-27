import { expect, type Page } from '@playwright/test';

// Excalidraw moves avatars into the +N menu when the toolbar has less space.
// Exercise the real UI in either layout; do not bypass it through the debug API.
export async function followFirstParticipant(page: Page) {
  const avatar = page.locator('.UserList .Avatar').first();
  const more = page.locator('.UserList__more');
  await expect(page.locator('.UserList .Avatar, .UserList__more').first()).toBeVisible();
  if (await avatar.isVisible()) {
    await avatar.click();
  } else {
    await more.click();
    await page.locator('.UserList__collaborators .UserList__collaborator').first().click();
    if (await page.locator('.UserList__collaborators').isVisible()) await more.click();
  }
}

import { test, expect } from '@playwright/test';
import { openApp } from './support/app-fixtures.mjs';

test('メニューは画面上部に表示され、入力欄には重複表示しない', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });

  const headerMenu = page.locator('#header .h-right > .h-menu-btn').last();
  await expect(headerMenu).toBeVisible();
  await expect(page.locator('#chatResetBtn')).toBeVisible();
  await expect(page.locator('#qrBtn')).toBeVisible();
  await expect(page.locator('#headerLogoutBtn')).toBeVisible();
  await expect(page.locator('#inputbarTools .inputbar-caption')).toBeHidden();
  await expect.poll(async () => page.locator('#inputbarTools .inputbar-actions > .h-menu-btn:last-child').evaluateAll((buttons) =>
    buttons.filter((button) => getComputedStyle(button).display !== 'none').length
  )).toBe(0);

  await headerMenu.click();
  await expect(page.locator('#menuSheet')).toHaveClass(/open/);
});

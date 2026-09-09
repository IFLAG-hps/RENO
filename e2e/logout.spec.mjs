import { test, expect } from '@playwright/test';
import { openApp } from './support/app-fixtures.mjs';

test('ログアウトするとPIN画面へ戻り、認証キャッシュを削除する', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#headerLogoutBtn')).toBeVisible();

  await page.locator('#headerLogoutBtn').click();

  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#pinScreen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('reno_auth_session_v1'))).toBeNull();
});

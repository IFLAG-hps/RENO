import { test, expect } from '@playwright/test';
import { installAppStubs } from './support/app-fixtures.mjs';

test('React シェルだけでメイン画面を起動できる', async ({ page }) => {
  const legacyRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('legacy-bootstrap.js')) legacyRequests.push(request.url());
  });
  await installAppStubs(page);

  await page.goto('/');

  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('#pinScreen')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#userInput')).toBeVisible();
  expect(legacyRequests).toEqual([]);
});

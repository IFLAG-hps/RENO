import { test, expect } from '@playwright/test';

test('旧静的ページ URL は React ルートとして表示される', async ({ page }) => {
  await page.goto('/pages/agent.html');
  await expect(page.locator('.agent-card').first()).toBeVisible();

  await page.goto('/pages/revenue.html');
  await expect(page.locator('.plans-grid')).toBeVisible();

  await page.goto('/pages/mockup.html');
  await expect(page.locator('.phone')).toBeVisible();
});

import { test, expect } from '@playwright/test';

test('旧静的ページ URL はReact版サイトへ到達できる', async ({ page }) => {
  for (const legacyPath of ['/pages/agent.html', '/pages/revenue.html', '/pages/mockup.html']) {
    await page.goto(legacyPath);
    await expect(page.locator('#root')).toBeVisible();
    await expect.poll(() => page.locator('#app, .agent-card, .plans-grid, .phone').count()).toBeGreaterThan(0);
  }
});

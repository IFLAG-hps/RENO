import { test, expect } from '@playwright/test';
import { installAppStubs } from './support/app-fixtures.mjs';

test('PC表示時だけスマホで開くQRコードを常駐表示する', async ({ page }) => {
  await installAppStubs(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();

  const dock = page.locator('#desktopQrDock');
  await expect(dock).toBeVisible();
  await expect(dock).toContainText('スマホで開く');
  await expect(dock.locator('img')).toBeVisible();
  expect((await dock.boundingBox()).width).toBeLessThan(170);
  const beforeDrag = await dock.boundingBox();
  const handle = dock.locator('.desktop-qr-dock-drag-handle');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 80, handleBox.y - 60);
  await page.mouse.up();
  const afterDrag = await dock.boundingBox();
  expect(afterDrag.x).toBeLessThan(beforeDrag.x);

  await page.setViewportSize({ width: 1023, height: 800 });
  await expect(dock).toBeHidden();
});

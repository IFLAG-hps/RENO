import { test, expect } from '@playwright/test';
import { openApp } from './support/app-fixtures.mjs';

test('定型ヒアリングはチャットAIを呼び出さない', async ({ page }) => {
  let chatRequestCount = 0;
  page.on('request', request => {
    if (request.url() !== 'http://e2e.local/agent' || request.method() !== 'POST') return;
    if (request.postDataJSON()?.type === 'chat') chatRequestCount += 1;
  });

  await openApp(page);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '浴室・洗面所' }).click();
  await expect(page.locator('#chat .msg.agent').last()).toContainText('浴室・洗面所のリフォームですね');

  await page.getByRole('button', { name: '床材' }).click();
  await expect(page.locator('#chat .msg.agent').last()).toContainText('浴室・洗面所のリフォーム');

  await page.getByRole('button', { name: '和風' }).click();
  await expect(page.locator('#chat .msg.agent').last()).toContainText('浴室・洗面所の床材を和風');
  expect(chatRequestCount).toBe(0);
});

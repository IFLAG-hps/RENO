import { test, expect } from '@playwright/test';

test('フロントエンドがデプロイ済みAPIで認証とチャットを実行できる', async ({ page }) => {
  const pin = process.env.E2E_PIN;
  if (!pin) throw new Error('E2E_PIN is required');

  await page.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js', (route) => route.abort());
  await page.addInitScript(() => {
    window.supabase = {
      createClient: () => ({ auth: {
        getSession: async () => ({ data: { session: null } }),
        signOut: async () => ({}),
        signInWithOAuth: async () => ({ data: {}, error: null }),
      } }),
    };
  });

  await page.goto(`/?pin=${encodeURIComponent(pin)}`);
  await expect(page.locator('#pinScreen')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#userInput').fill('CIからの接続確認です');
  await page.locator('#sendBtn').click();
  await expect(page.locator('#chat .msg.agent').last()).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#chat .msg.agent').last()).not.toBeEmpty();
});

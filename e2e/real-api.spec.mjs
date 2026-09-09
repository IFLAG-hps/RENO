import { test, expect } from '@playwright/test';

test('フロントエンドがデプロイ済みAPIで認証とチャットを実行できる', async ({ page }) => {
  test.skip(!process.env.E2E_COGNITO_EMAIL || !process.env.E2E_COGNITO_PASSWORD || !process.env.COGNITO_CLIENT_ID,
    'Cognito E2E credentials are not configured');

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

  await page.goto('/');
  await page.locator('#adminEmailInput').fill(process.env.E2E_COGNITO_EMAIL);
  await page.locator('#adminPasswordInput').fill(process.env.E2E_COGNITO_PASSWORD);
  await page.locator('#googleLoginBtn').click();
  await expect(page.locator('#pinScreen')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#userInput').fill('CIからの接続確認です');
  await page.locator('#sendBtn').click();
  await expect(page.locator('#chat .msg.agent').last()).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('#chat .msg.agent').last()).not.toBeEmpty();
});

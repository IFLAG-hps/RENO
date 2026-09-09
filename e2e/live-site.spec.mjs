import { test, expect } from '@playwright/test';

async function waitForReactShell(page) {
  await expect(page.locator('#root')).toBeAttached({ timeout: 20_000 });
  await expect.poll(
    () => page.locator('#app:visible, #pinScreen:visible').count(),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
}

async function isAuthenticated(page) {
  return (await page.locator('#app:visible').count()) > 0;
}

test.describe('@live-site live site smoke tests', () => {
  test('React shell starts and the agent can be used when a session is available', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/');
    await waitForReactShell(page);

    if (!(await isAuthenticated(page))) {
      await expect(page.locator('#adminLoginSection')).toBeVisible();
      return;
    }

    await expect(page.locator('#userInput')).toBeVisible();
    await page.locator('#userInput').fill('オンライン実サイトの動作確認です');
    await page.locator('#sendBtn').click();
    await expect(page.locator('#chat .msg.user')).toHaveCount(1);
    await expect.poll(async () => {
      const messages = await page.locator('#chat .msg.agent').allInnerTexts();
      return messages.at(-1)?.trim() || '';
    }, { timeout: 30_000 }).toMatch(/^(?!…$)(?!一時的に応答を取得できませんでした)/);

    expect(consoleErrors).toEqual([]);
  });

  test('QR and legacy routes reach the React site', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForReactShell(page);

    if (await isAuthenticated(page)) {
      const qr = page.locator('#desktopQrDock img');
      await expect(qr).toBeVisible({ timeout: 20_000 });
      await expect.poll(async () => page.evaluate(() => {
        const src = document.querySelector('#desktopQrDock img')?.src;
        return src ? new URL(src).searchParams.get('data') : null;
      })).toBe(`${new URL(page.url()).origin}/`);
    } else {
      await expect(page.locator('#adminLoginSection')).toBeVisible();
    }

    for (const legacyPath of ['/pages/agent.html', '/pages/revenue.html', '/pages/mockup.html']) {
      await page.goto(legacyPath);
      await expect(page.locator('#root')).toBeAttached({ timeout: 20_000 });
      await expect.poll(
        () => page.locator('#app, .agent-card, .plans-grid, .phone').count(),
        { timeout: 20_000 },
      ).toBeGreaterThan(0);
    }
  });

  test('conversation reset returns to the initial state when a session is available', async ({ page }) => {
    await page.goto('/');
    await waitForReactShell(page);

    if (!(await isAuthenticated(page))) {
      await expect(page.locator('#adminLoginSection')).toBeVisible();
      return;
    }

    await page.locator('#userInput').fill('リセット動作の確認です');
    await page.locator('#sendBtn').click();
    await expect(page.locator('#chat .msg.user')).toHaveCount(1);
    await expect.poll(async () => page.locator('#chat .msg.agent').count()).toBeGreaterThan(1, { timeout: 30_000 });

    await page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#chatResetBtn').click();
    await expect(page.locator('#chat .msg.user')).toHaveCount(0);
    await expect(page.locator('#chat .msg.agent')).toHaveCount(1);
    await expect.poll(async () => page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('reno_chat_history_v1:')),
    )).toEqual([]);
  });
});

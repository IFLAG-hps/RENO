export async function installAppStubs(page) {
  await page.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js', (route) => route.abort());
  if (process.env.E2E_USE_REAL_API !== 'true') {
    await page.route('**/assets/reno-config.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.RENO_CONFIG={apiUrl:"http://e2e.local/agent",mockChat:false,supabaseUrl:"https://e2e.supabase.co",supabaseAnonKey:"e2e-anon"};',
    }));
    const respond = async (route) => {
      const body = route.request().postDataJSON();
      if (body.type === 'verify_pin' || body.type === 'demo_login') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'e2e-token', role: 'guest' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        content: [{ type: 'text', text: 'ご相談内容を確認しました。現在の状況とご希望の部屋の詳細を教えてください。\n[SUGGESTIONS: 素材を探す, 概算を見る, 施工後イメージ]' }],
        usage: { count: 1, limit: 10, remaining: 9 },
      }) });
    };
    await page.route('**/agent', respond);
    await page.route('**/reno-agent', respond);
  }
  await page.addInitScript(() => {
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          signOut: async () => ({}),
          signInWithOAuth: async () => ({ data: {}, error: null }),
        },
      }),
    };
    if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
      localStorage.setItem('reno_auth_session_v1', JSON.stringify({
        token: 'e2e-token',
        role: 'guest',
        savedAt: Date.now(),
      }));
    }
  });
}

export async function openApp(page) {
  await installAppStubs(page);
  await page.goto('/');
}

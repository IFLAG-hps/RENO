
import {
  getTemplateActionResponse,
  getTemplateAgentResponse,
} from './template-chat-flow.js';

// ── Config ──
const EDGE_URL      = window.RENO_CONFIG?.apiUrl || '';
const EDGE_HEADERS  = {};
const supabaseAuth  = null;
// The picker keeps its actual selection helper inside its initializer. This
// placeholder makes the exported compatibility surface valid at module scope.
const getSelectedChar = () => '';
const render = () => {};
if (!EDGE_URL) {
  console.warn('RENO: API URLが設定されていません。デモモックモードで起動します。');
}

// ── Timeout付きfetch（画像生成など時間のかかるリクエスト用）──
// AbortControllerで指定ミリ秒後に強制中断し、タイムアウト専用のエラーを投げる
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const timeoutErr = new Error('TIMEOUT');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `あなたはRENOのAIリフォームコンサルタントです。
施主とフレンドリーにチャットし、要望をヒアリングして施工後のビジュアルイメージ生成を提案します。

## 会話の流れ
1. 温かく挨拶し、どの部屋をリフォームしたいか聞く
2. 変えたい箇所を具体的に聞く（床・壁・キッチンなど）
3. 好みのスタイルを聞く
4. 十分な情報が集まったら「では実際のお部屋の写真を撮って送ってください！」と促し、写真が届いたら [GENERATE_IMAGE:...] を出力する
   ※写真が届く前に [GENERATE_IMAGE] を出力しない

## タグのルール

### [SUGGESTIONS: 選択肢1, 選択肢2, ...]
毎回の返答の末尾に付ける。文脈に合った3〜5個の短い日本語。
- 部屋を聞く: [SUGGESTIONS: リビング, キッチン, 浴室・洗面所, 寝室, 玄関]
- 箇所を聞く: [SUGGESTIONS: 床材, 壁紙, キッチン設備, 照明, 収納]
- スタイルを聞く: [SUGGESTIONS: モダン, ナチュラル, 和風, インダストリアル, 北欧風]
- 予算を聞く: [SUGGESTIONS: 50万円以下, 50〜100万円, 100〜200万円, 200万円以上]
- 写真を促す: [SUGGESTIONS: 📷 写真を撮る・選ぶ]
- 画像生成後: [SUGGESTIONS: 別の箇所も試す, 昼/夜を見る, 概算を見る, 提案書を作成]

### [GENERATE_IMAGE: 英語プロンプト]
英語で記述。変更箇所を明確に、"Keep everything else exactly the same. Photorealistic interior design." で締める。
写真が届いていない場合は絶対に出力しない。

### [SHOW_SIMULATOR]
「概算を見る」「いくらかかる」など費用の話が出たとき。

### [SHOW_MATERIAL: キー]
素材について「詳しく」「耐久性」「お手入れ」と聞かれたとき。
キー: oak, composite, tile, cushion, plaster, vinyl, concrete, marble, tatami

### [SHOW_CASES: room, style]
「事例を見る」「参考事例」と言われたとき。

## 重要なルール
- 常に日本語で返答
- [GENERATE_IMAGE] または [SHOW_SIMULATOR] または [SHOW_MATERIAL] または [SHOW_CASES] がある場合は [SUGGESTIONS] は不要
- 返答は2〜3文と短く
- 一度に聞く質問は1つ
- 親しみやすい言葉を使う`;

// チャット相談は画面確認用のローカルモック。実APIへ切り替える場合はfalseにする。
const MOCK_CHAT_MODE = window.RENO_CONFIG?.mockChat ?? true;


// ── 安全なlocalStorageラッパー ──
// 一部のブラウザ環境(iOS標準QRリーダー内蔵ブラウザ等)ではlocalStorageアクセスが
// 例外を投げることがあり、放置すると以降のスクリプト全体が壊れるため必ずtry/catchする
function safeLocalGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
}
function safeLocalSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

// ── SE Sound Engine ──
let seEnabled = safeLocalGet('reno_se', 'on') !== 'off';
let audioCtx = null;

function initAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function toggleSE(on) {
  seEnabled = on;
  safeLocalSet('reno_se', on ? 'on' : 'off');
  if (on) { initAudioCtx(); playSound('chip'); }
}

function playSound(type) {
  if (!seEnabled) return;
  try {
    initAudioCtx();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);

    if (type === 'chip') {
      // 軽いクリック：短いタップ音
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(880, now); o.frequency.exponentialRampToValueAtTime(660, now + 0.06);
      g.gain.setValueAtTime(0.18, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      o.connect(g); o.start(now); o.stop(now + 0.08);

    } else if (type === 'send') {
      // メッセージ送信：ポップ↑
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(600, now); o.frequency.exponentialRampToValueAtTime(900, now + 0.1);
      g.gain.setValueAtTime(0.15, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      o.connect(g); o.start(now); o.stop(now + 0.12);

    } else if (type === 'receive') {
      // AI返答：やわらかいチャイム
      [880, 1100].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const gi = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        gi.gain.setValueAtTime(0, now + i * 0.08);
        gi.gain.linearRampToValueAtTime(0.12, now + i * 0.08 + 0.02);
        gi.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.25);
        o.connect(gi); gi.connect(ctx.destination);
        o.start(now + i * 0.08); o.stop(now + i * 0.08 + 0.25);
      });

    } else if (type === 'complete') {
      // 画像生成完了：達成チャイム3音
      [660, 880, 1100].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const gi = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        gi.gain.setValueAtTime(0, now + i * 0.1);
        gi.gain.linearRampToValueAtTime(0.14, now + i * 0.1 + 0.02);
        gi.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.3);
        o.connect(gi); gi.connect(ctx.destination);
        o.start(now + i * 0.1); o.stop(now + i * 0.1 + 0.3);
      });

    } else if (type === 'upload') {
      // 写真アップ：カメラシャッター風
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.06, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = ctx.createBufferSource();
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2000;
      src.buffer = buf; src.connect(f); f.connect(g);
      g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      src.start(now);
    }
  } catch(e) {}
}

// SEトグルの初期状態を反映
document.addEventListener('DOMContentLoaded', () => {
  const tog = document.getElementById('seToggle');
  if (tog) tog.checked = seEnabled;
  initIconPicker();
  // PCならQRボタン表示
  const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
  if (isDesktop) {
    ['qrBtn', 'inputQrBtn'].forEach((id) => {
      const qrBtn = document.getElementById(id);
      if (qrBtn) qrBtn.style.display = 'flex';
    });
  }
  const qrUrl = document.querySelector('.qr-url');
  if (qrUrl) qrUrl.textContent = `${location.origin}${location.pathname}`;
  // PWAモード（スタンドアロン）なら「ブラウザで開く」を表示
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) {
    const el = document.getElementById('openBrowserWrap');
    if (el) el.style.display = 'block';
  }
});

// ── Agent Icon Picker ──
function initIconPicker() {
  const sel = document.getElementById('charSelector');
  if (!sel) return;

  // キャラクター定義
  const CHARS = [
    {
      id: 'female',
      name: '女性',
      icons: ['f1','f2','f3'],
      defaultId: 'f1',
      auto: true,
    },
    {
      id: 'male',
      name: '男性',
      icons: ['m1','m2','m3'],
      defaultId: 'm1',
      auto: true,
    },
    {
      id: 'logo',
      name: 'ロゴ',
      icons: ['logo'],
      defaultId: 'logo',
      auto: false,
    },
  ];

  // 現在どのキャラが選ばれているか判定
  function getSelectedChar() {
    if (_agentIconId.startsWith('f')) return 'female';
    if (_agentIconId.startsWith('m')) return 'male';
    return 'none';
  }

  sel.innerHTML = '';
  CHARS.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'char-card' + (getSelectedChar() === ch.id ? ' selected' : '');

    // プレビュー画像
    const preview = document.createElement('div');
    preview.className = 'char-preview';
    if (ch.icons.length > 0) {
      ch.icons.forEach(iconId => {
        const ic = AGENT_ICONS.find(i => i.id === iconId);
        if (ic) {
          const img = document.createElement('img');
          img.src = ic.src;
          img.alt = ic.label;
          preview.appendChild(img);
        }
      });
    } else {
      const none = document.createElement('div');
      none.className = 'none-preview';
      none.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--border2)" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
      preview.appendChild(none);
    }
    card.appendChild(preview);

    // 名前
    const name = document.createElement('div');
    name.className = 'char-name';
    name.textContent = ch.name;
    card.appendChild(name);

    // 自動切替バッジ
    if (ch.auto) {
      const badge = document.createElement('div');
      badge.className = 'char-auto-badge';
      badge.textContent = '表情 自動切替';
      card.appendChild(badge);
    } else {
      const desc = document.createElement('div');
      desc.className = 'char-desc';
      desc.textContent = 'ブランドロゴを表示';
      card.appendChild(desc);
    }

    card.onclick = () => {
      _agentIconId = ch.defaultId;
      _currentIconId = ch.defaultId;
      safeLocalSet('reno_agent_icon', ch.defaultId);
      playSound('chip');
      sel.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      // 既存メッセージのアバターを全部即反映
      document.querySelectorAll('.avatar.agent img').forEach(img => {
        img.src = getAgentIconHTML().match(/src="([^"]+)"/)?.[1] || '';
      });
    };

    sel.appendChild(card);
  });
}

// ── QR Modal ──
function openQrModal() { document.getElementById('qrModal').classList.add('open'); }
function closeQrModal(e) {
  if (!e || e.target === document.getElementById('qrModal')) {
    document.getElementById('qrModal').classList.remove('open');
  }
}
function switchQrTab(tab, el) {
  document.querySelectorAll('.qr-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('qrStepsIos').style.display     = tab === 'ios'     ? 'block' : 'none';
  document.getElementById('qrStepsAndroid').style.display = tab === 'android' ? 'block' : 'none';
}
async function copyQrUrl() {
  const appUrl = `${location.origin}${location.pathname}`;
  try { await navigator.clipboard.writeText(appUrl); }
  catch(e) { const ta = document.createElement('textarea'); ta.value=appUrl; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
  const btn = event.target;
  btn.textContent = 'コピーしました！';
  setTimeout(() => { btn.textContent = 'URLをコピー'; }, 2000);
}

// ── Open in Browser (PWA) ──
async function copyUrlAndNotify() {
  try {
    await navigator.clipboard.writeText(location.href);
  } catch(e) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = location.href;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  const toast = document.getElementById('copyToast');
  if (toast) {
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
  }
}

// ── Safari viewport fix ──
if (window.visualViewport) {
  const setVh = () => {
    document.documentElement.style.setProperty('--vh', `${window.visualViewport.height * 0.01}px`);
  };
  window.visualViewport.addEventListener('resize', setVh);
  setVh();
}

// ── PIN & Token Auth ──
let pinValue = '';
let sessionToken = '';
let pinChecking = false;
let sessionRole = '';
let sessionEmail = '';
let sessionLabel = '';
let sessionAvatar = '';
const AUTH_CACHE_KEY = 'reno_auth_session_v1';
const AUTH_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// ページ読み込み時に必ずpinCheckingをリセット
window.addEventListener('load', async () => {
  pinChecking = false; pinValue = ''; renderDots();
  // URL PINを最優先し、それ以外はGoogleセッション→保存済みセッションの順に復元
  const urlPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '');
  if (urlPin.length === 4) {
    initLoginView();
    return;
  }
  const googleHandled = await handleGoogleRedirect();
  if (googleHandled || restoreCachedSession()) return;
  if (urlPin.length === 4) {
    initLoginView();
  } else {
    startDemoSession();
  }
});

function saveAuthSession(data) {
  try {
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
      token: data.token,
      role: data.role || '',
      email: data.email || '',
      label: data.label || '',
      savedAt: Date.now()
    }));
  } catch (e) {}
}

function restoreCachedSession() {
  try {
    const cached = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY) || 'null');
    if (!cached?.token || !cached.savedAt || Date.now() - cached.savedAt > AUTH_CACHE_MAX_AGE) {
      localStorage.removeItem(AUTH_CACHE_KEY);
      return false;
    }
    applySession(cached);
    return true;
  } catch (e) {
    return false;
  }
}

function clearAuthSession() {
  try { localStorage.removeItem(AUTH_CACHE_KEY); } catch (e) {}
}

function initLoginView() {
  const params = new URLSearchParams(location.search);
  const urlPin = (params.get('pin') || '').replace(/\D/g, '');
  if (urlPin.length === 4) {
    document.getElementById('pinScreen').style.display = 'flex';
    showGuestPinManually();
    pinValue = urlPin;
    renderDots();
    setTimeout(checkPin, 300);
  }
}

function showGuestPinManually() {
  document.getElementById('guestPinSection').style.display = '';
  // PIN付きURLで入った場合も、管理者は同じ画面からログインできるようにする。
  document.getElementById('adminLoginSection').style.display = 'none';
}

async function startDemoSession() {
  if (!EDGE_URL) {
    applySession({ token: 'demo-local', role: 'guest', label: '動作デモ' });
    return;
  }
  try {
    const demoId = safeLocalGet('reno_demo_id', '') || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    safeLocalSet('reno_demo_id', demoId);
    const res = await fetchWithTimeout(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'demo_login', demo_id: demoId })
    }, 15000);
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(data.error || 'デモセッションを開始できません');
    applySession(data);
  } catch (error) {
    console.error(error);
    const status = document.getElementById('googleLoginStatus');
    if (status) status.textContent = 'デモを開始できません。時間をおいて再読み込みしてください。';
  }
}

// PC keyboard support
document.addEventListener('keydown', (e) => {
  if (document.getElementById('pinScreen').style.display === 'none') return;
  if (e.key >= '0' && e.key <= '9') pinKey(e.key);
  else if (e.key === 'Backspace') pinDel();
});

function pinKey(k) {
  if (pinChecking) {
    // 5秒以上経過していたら強制リセット（フリーズ対策）
    const now = Date.now();
    if (!pinKey._lastCheck || now - pinKey._lastCheck > 5000) {
      pinChecking = false;
      pinValue = '';
      renderDots();
    } else {
      return;
    }
  }
  pinKey._lastCheck = Date.now();
  if (pinValue.length >= 4) return;
  pinValue += k;
  renderDots();
  if (pinValue.length === 4) setTimeout(checkPin, 120);
}

function pinDel() {
  if (pinChecking) return;
  pinValue = pinValue.slice(0, -1);
  renderDots();
}

function renderDots(state = 'normal') {
  for (let i = 0; i < 4; i++) {
    const d = document.getElementById('d' + i);
    if (state === 'normal' && pinValue.length === i) {
      d.innerHTML = '<span class="pin-caret" aria-hidden="true"></span>';
    } else {
      d.textContent = pinValue.length > i ? '●' : '';
    }
    d.className = 'pin-dot'
      + (pinValue.length > i ? ' filled' : '')
      + (state === 'error' ? ' error' : '')
      + (state === 'loading' ? ' loading' : '');
  }
}

// ── DOM出力ヘルパー ──
// 会話・AI応答・保存データは必ず文字列として表示し、HTMLとして解釈させない。
function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeImageSrc(value) {
  const src = String(value ?? '').trim();
  if (!src) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(src)) return src;
  try {
    const url = new URL(src, location.href);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:') return url.href;
  } catch (e) {}
  return '';
}

function escapeJSString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function applySession(data) {
  sessionToken = data.token;
  sessionRole  = data.role || '';
  sessionEmail = data.email || '';
  sessionLabel = data.label || '';
  saveAuthSession(data);
  pinValue = '';
  renderDots();
  document.getElementById('pinScreen').style.display = 'none';
  const app = document.getElementById('app');
  app.style.display = 'flex';
  const gpinMenuItem = document.getElementById('gpinMenuItem');
  if (gpinMenuItem) gpinMenuItem.style.display = sessionRole === 'admin' ? '' : 'none';
  const avatarBtn = document.getElementById('userAvatarBtn');
  if (avatarBtn) {
    avatarBtn.style.display = sessionRole === 'admin' ? '' : 'none';
    document.getElementById('userAvatarImg').src = sessionAvatar || '';
    document.getElementById('userMenuEmail').textContent = sessionEmail || '';
  }
  if (!chatStarted) initChat();
  if (location.search) { try { window.history.replaceState(null, '', location.pathname); } catch (e) {} }
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('userMenu');
  const btn = document.getElementById('userAvatarBtn');
  if (!menu || menu.style.display === 'none') return;
  if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});

async function switchGoogleAccount() {
  document.getElementById('userMenu').style.display = 'none';
  clearAuthSession();
  if (supabaseAuth) await supabaseAuth.auth.signOut().catch(() => {});
  loginWithGoogle(true);
}

async function checkPin() {
  if (pinChecking) return;
  pinChecking = true;
  renderDots('loading');
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'verify_pin', pin: pinValue }),
    });
    const data = await res.json();
    if (res.ok && data.token) {
      applySession(data);
      pinChecking = false;
    } else {
      renderDots('error');
      setTimeout(() => { pinValue = ''; renderDots(); pinChecking = false; }, 800);
    }
  } catch(e) {
    // ネットワークエラー時もリセット
    renderDots('error');
    setTimeout(() => { pinValue = ''; renderDots(); pinChecking = false; }, 800);
  }
}

// ── Google ログイン（管理者専用） ──
let cognitoChallengeSession = '';
let cognitoUsername = '';
let cognitoChallengeName = '';

async function cognitoRequest(target, body) {
  const region = window.RENO_CONFIG?.cognitoRegion || 'ap-northeast-1';
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Cognito login failed');
  return data;
}

async function loginWithCognito() {
  const statusEl = document.getElementById('googleLoginStatus');
  const button = document.getElementById('googleLoginBtn');
  const email = document.getElementById('adminEmailInput')?.value.trim();
  const password = document.getElementById('adminPasswordInput')?.value;
  const newPassword = document.getElementById('adminNewPasswordInput')?.value;
  const mfa = document.getElementById('adminMfaInput')?.value.trim();
  const clientId = window.RENO_CONFIG?.cognitoClientId || '';
  if (!clientId) { if (statusEl) statusEl.textContent = 'Cognito設定が未反映です'; return; }
  if (!email || !password) { if (statusEl) statusEl.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  button.disabled = true;
  if (statusEl) statusEl.textContent = '管理者認証中...';
  try {
    let auth;
    if (cognitoChallengeSession) {
      if (cognitoChallengeName === 'NEW_PASSWORD_REQUIRED') {
        if (!newPassword) throw new Error('新しいパスワードを入力してください');
        auth = await cognitoRequest('RespondToAuthChallenge', {
          ClientId: clientId,
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: cognitoChallengeSession,
          ChallengeResponses: { USERNAME: cognitoUsername, NEW_PASSWORD: newPassword }
        });
      } else {
        if (!mfa) throw new Error('MFAコードを入力してください');
        auth = await cognitoRequest('RespondToAuthChallenge', {
          ClientId: clientId,
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: cognitoChallengeSession,
          ChallengeResponses: { USERNAME: cognitoUsername, SOFTWARE_TOKEN_MFA_CODE: mfa }
        });
      }
    } else {
      cognitoUsername = email;
      auth = await cognitoRequest('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password }
      });
    }
    if (auth.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      cognitoChallengeSession = auth.Session;
      cognitoChallengeName = auth.ChallengeName;
      document.getElementById('adminMfaInput').style.display = '';
      if (statusEl) statusEl.textContent = '認証アプリの6桁コードを入力してください';
      return;
    }
    if (auth.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      cognitoChallengeSession = auth.Session;
      cognitoChallengeName = auth.ChallengeName;
      document.getElementById('adminNewPasswordInput').style.display = '';
      if (statusEl) statusEl.textContent = '初回ログインのため新しいパスワードを入力してください';
      return;
    }
    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!accessToken) throw new Error('認証トークンを取得できませんでした');
    const res = await fetch(EDGE_URL, {
      method: 'POST', headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cognito_login', access_token: accessToken })
    });
    const data = await res.json();
    if (!res.ok || !data.token || data.role !== 'admin') throw new Error(data.error || '管理者権限がありません');
    cognitoChallengeSession = '';
    cognitoChallengeName = '';
    document.getElementById('adminNewPasswordInput').style.display = 'none';
    document.getElementById('adminMfaInput').style.display = 'none';
    applySession(data);
  } catch (e) {
    if (statusEl) statusEl.textContent = e.message || '管理者ログインに失敗しました';
    if (!cognitoChallengeSession) {
      document.getElementById('adminMfaInput').style.display = 'none';
      document.getElementById('adminNewPasswordInput').style.display = 'none';
    }
  } finally {
    button.disabled = false;
  }
}

async function loginWithGoogle(forceChooser) {
  const statusEl = document.getElementById('googleLoginStatus');
  if (!supabaseAuth) {
    if (statusEl) statusEl.textContent = 'Googleログインは現在利用できません';
    return;
  }
  if (statusEl) statusEl.textContent = 'Googleに接続しています...';
  try {
    await supabaseAuth.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: location.origin + location.pathname,
        queryParams: forceChooser ? { prompt: 'select_account' } : undefined
      }
    });
  } catch (e) {
    if (statusEl) statusEl.textContent = 'ログインを開始できませんでした。';
  }
}

// Googleでのリダイレクト後、Supabaseセッションを確認してRENOのトークンに交換する（管理者のみ許可）
async function handleGoogleRedirect() {
  const statusEl = document.getElementById('googleLoginStatus');
  if (!supabaseAuth) {
    document.documentElement.classList.remove('oauth-pending');
    return false;
  }
  try {
    const { data: { session } } = await supabaseAuth.auth.getSession();
    if (!session) {
      document.documentElement.classList.remove('oauth-pending');
      return false;
    }
    sessionAvatar = session.user?.user_metadata?.avatar_url || session.user?.user_metadata?.picture || '';
    if (statusEl) statusEl.textContent = 'ログイン中...';
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'google_login', access_token: session.access_token }),
    });
    const data = await res.json();
    if (res.ok && data.token) {
      applySession(data);
      return true;
    } else {
      if (statusEl) statusEl.textContent = data.error || 'ログインに失敗しました';
      await supabaseAuth.auth.signOut().catch(() => {});
      return false;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'ログインに失敗しました。';
    return false;
  } finally {
    document.documentElement.classList.remove('oauth-pending');
  }
}

function openAdminLogin() {
  lockApp();
  setTimeout(() => document.getElementById('adminEmailInput')?.focus(), 50);
}

function logoutApp() {
  lockApp();
}

function resetClientCache() {
  if (!window.confirm('保存した会話と端末内の設定を削除します。実行しますか？')) return;
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  window.location.reload();
}

function lockApp() {
  pinValue = '';
  sessionToken = '';
  sessionRole = '';
  sessionEmail = '';
  sessionLabel = '';
  sessionAvatar = '';
  clearAuthSession();
  pinChecking = false;
  renderDots();
  document.getElementById('pinScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('guestPinSection').style.display = 'none';
  document.getElementById('adminLoginSection').style.display = 'none';
  const avatarBtn = document.getElementById('userAvatarBtn');
  if (avatarBtn) avatarBtn.style.display = 'none';
  const userMenu = document.getElementById('userMenu');
  if (userMenu) userMenu.style.display = 'none';
  // URLに?pinが残っているとリロード時に再度ゲスト扱いになるので消しておく
  if (location.search) { try { window.history.replaceState(null, '', location.pathname); } catch (e) {} }
  if (supabaseAuth) supabaseAuth.auth.signOut().catch(() => {});
  startDemoSession();
}

// ── Chat ──
let history = [];
let chatStarted = false;
let chatResetToken = 0;
const CHAT_CACHE_PREFIX = 'reno_chat_history_v1:';
const CHAT_STATE_SUFFIX = ':state';
const ACTIVE_SESSION_SUFFIX = ':active-session';
let currentSessionId = '';

function chatCacheKey() {
  return CHAT_CACHE_PREFIX + (sessionEmail || 'guest');
}

function chatStateKey() {
  return chatCacheKey() + CHAT_STATE_SUFFIX;
}

function activeSessionKey() {
  return chatCacheKey() + ACTIVE_SESSION_SUFFIX;
}

function loadActiveSessionId() {
  return safeLocalGet(activeSessionKey(), '');
}

function setActiveSessionId(sessionId) {
  currentSessionId = String(sessionId || '');
  if (currentSessionId) safeLocalSet(activeSessionKey(), currentSessionId);
  else {
    try { localStorage.removeItem(activeSessionKey()); } catch (e) {}
  }
}

async function ensureSession() {
  if (currentSessionId || !EDGE_URL) return currentSessionId;
  if (!sessionToken) throw new Error('ログインセッションがありません');
  const res = await fetchWithTimeout(EDGE_URL, {
    method: 'POST',
    headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken, type: 'create_session' }),
  });
  const data = await res.json();
  const sessionId = data?.session?.sessionId;
  if (!res.ok || !sessionId) throw new Error(data?.error || '相談セッションを作成できませんでした');
  setActiveSessionId(sessionId);
  return sessionId;
}

async function saveMockChatTurn(userMessage, assistantMessage) {
  if (!currentSessionId || !EDGE_URL || !userMessage || !assistantMessage) return;
  const res = await fetchWithTimeout(EDGE_URL, {
    method: 'POST',
    headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: sessionToken,
      type: 'save_chat_turn',
      sessionId: currentSessionId,
      userMessage,
      assistantMessage,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || '会話を保存できませんでした');
  }
}

function persistChatHistory() {
  try {
    const compact = history.slice(-120).map(message => ({
      role: message.role,
      content: String(message.content || '').slice(0, 4000)
    }));
    localStorage.setItem(chatCacheKey(), JSON.stringify(compact));
  } catch (e) {}
}

function persistChatState(activeView = '') {
  try {
    const chat = document.getElementById('chat');
    const chatSnapshot = chat
      ? chat.innerHTML
          .replace(/\s(?:src|href)="data:[^"]*"/gi, '')
          .replace(/<div class="msg agent" id="typing">[\s\S]*?<\/div>\s*<\/div>/g, '')
      : '';
    localStorage.setItem(chatStateKey(), JSON.stringify({
      activeView,
      chatSnapshot: chatSnapshot.length <= 900000 ? chatSnapshot : '',
      draftText: document.getElementById('userInput')?.value || '',
      simState: {
        sizeIdx: simState.sizeIdx,
        items: [...simState.items],
        gradeIdx: simState.gradeIdx,
      },
      selectedMaterialKey: window._selectedMaterialKey || '',
      pendingUploadPrompt: window._pendingUploadPrompt || '',
      savedAt: Date.now(),
    }));
  } catch (e) {}
}

function persistCurrentChatState() {
  const activeView = document.getElementById('final-confirm-msg')
    ? 'final-confirm'
    : document.getElementById('sim-msg')
      ? 'simulator'
      : document.getElementById('upload-msg')
        ? 'upload'
        : document.getElementById('ideal-msg')
          ? 'ideal-image'
          : document.getElementById('daynight-msg')
            ? 'daynight'
            : document.querySelector('.mat-card')
              ? 'material'
              : document.querySelector('.quick-form')
                ? 'quick-form'
                : '';
  persistChatState(activeView);
}

function restoreChatState() {
  try {
    const state = JSON.parse(localStorage.getItem(chatStateKey()) || 'null');
    if (!state || !state.simState) return { activeView: '' };
    const next = state.simState;
    if (Number.isInteger(next.sizeIdx) && COST_DATA.sizes[next.sizeIdx]) simState.sizeIdx = next.sizeIdx;
    if (Number.isInteger(next.gradeIdx) && COST_DATA.grades[next.gradeIdx]) simState.gradeIdx = next.gradeIdx;
    if (Array.isArray(next.items)) {
      const restoredItems = next.items.filter(key => COST_DATA.items.some(item => item.key === key));
      // 空の保存値は旧バージョンの状態や初期化直後の状態なので、既定候補に戻す。
      simState.items = new Set(restoredItems.length ? restoredItems : DEFAULT_SIM_ITEMS);
    }
    if (state.selectedMaterialKey) window._selectedMaterialKey = state.selectedMaterialKey;
    if (state.pendingUploadPrompt) window._pendingUploadPrompt = state.pendingUploadPrompt;
    return {
      activeView: state.activeView || '',
      chatSnapshot: state.chatSnapshot || '',
      draftText: state.draftText || '',
      pendingUploadPrompt: state.pendingUploadPrompt || '',
    };
  } catch (e) {
    return { activeView: '' };
  }
}

function clearDraftCache() {
  try {
    localStorage.removeItem(chatCacheKey());
    localStorage.removeItem(chatStateKey());
  } catch (e) {}
}

function resetConversation() {
  if (!window.confirm('現在の会話を消去して、最初から始めますか？')) return;

  // 進行中の応答があっても、リセット後の画面へ古い応答を追加させない。
  chatResetToken += 1;
  removeTyping();
  clearDraftCache();
  setActiveSessionId('');
  history = [];
  window._beforeFile = null;
  window._beforeURL = '';
  window._lastAfterSrc = '';
  window._lastBeforeSrc = '';
  window._genPrompt = '';
  window._selectedMaterialKey = '';
  window._pendingUploadPrompt = '';
  if (simState) simState = { sizeIdx: 1, items: new Set(DEFAULT_SIM_ITEMS), gradeIdx: 1 };
  finalizationState = 'draft';
  finalHandoffStarted = false;

  const input = document.getElementById('userInput');
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  document.getElementById('chat').innerHTML = '';
  document.getElementById('sendBtn').disabled = false;
  chatStarted = false;
  initChat();
}

function restoreCachedChat(cached, skipInteractive = false) {
  cached.forEach(message => {
    if (!message || !message.role || !message.content) return;
    if (message.role === 'user') {
      addUserMessage(message.content);
      return;
    }
    const raw = String(message.content);
    const genMatch = raw.match(/\[GENERATE_IMAGE:\s*([\s\S]+?)\]/);
    const simMatch = raw.match(/\[SHOW_SIMULATOR\]/);
    const matMatch = raw.match(/\[SHOW_MATERIAL:\s*(\w+)\]/);
    const qfMatch = raw.match(/\[QUICK_FORM:\s*([\s\S]+?)\]/);
    const sugMatch = raw.match(/\[SUGGESTIONS:\s*(.+?)\]/);
    const display = raw
      .replace(/\[GENERATE_IMAGE:[\s\S]+?\]/g, '')
      .replace(/\[SHOW_SIMULATOR\]|\[SHOW_MATERIAL:\s*\w+\]|\[SHOW_CASES:[^\]]*\]/g, '')
      .replace(/\[QUICK_FORM:[\s\S]+?\]|\[SUGGESTIONS:.+?\]/g, '')
      .trim();
    if (display) addAgentMessage(display);
    if (!skipInteractive) {
      if (genMatch) showUploadCard(genMatch[1].trim());
      else if (simMatch) showSimulator();
      else if (matMatch) showMaterial(matMatch[1].trim());
      else if (qfMatch) showQuickForm(qfMatch[1].trim());
      if (sugMatch) renderSuggestions(sugMatch[1].split(',').map(s => s.trim()).filter(Boolean));
    }
  });
}

function restoreInteractiveSuggestions() {
  const row = document.getElementById('suggestions-row');
  if (!row) return;
  const labels = [...row.querySelectorAll('.chip')]
    .map(button => button.textContent.trim())
    .filter(Boolean);
  if (labels.length) renderSuggestions(labels);
}

function initChat() {
  chatStarted = true;
  currentSessionId = loadActiveSessionId();
  fetchUsage();
  const savedState = restoreChatState();
  try {
    const cached = JSON.parse(localStorage.getItem(chatCacheKey()) || '[]');
    if (Array.isArray(cached) && cached.length) {
      history = cached;
      const canRestoreSnapshot = savedState.chatSnapshot
        && !savedState.chatSnapshot.includes('quick-form')
        && !savedState.chatSnapshot.includes('id="typing"');
      if (canRestoreSnapshot) {
        document.getElementById('chat').innerHTML = savedState.chatSnapshot;
        refreshAgentAvatars();
        restoreInteractiveSuggestions();
      } else {
        restoreCachedChat(cached, ['final-confirm', 'material'].includes(savedState.activeView));
      }
      if (savedState.activeView === 'final-confirm') {
        finalizationState = 'review';
        if (!document.getElementById('final-confirm-msg')) {
          document.getElementById('sim-msg')?.remove();
          showFinalConfirmation();
        }
      } else if (savedState.activeView === 'simulator' && !document.getElementById('sim-msg')) {
        showSimulator();
      } else if (savedState.activeView === 'material' && window._selectedMaterialKey && !document.querySelector('.mat-card')) {
        showMaterial(window._selectedMaterialKey);
      } else if (savedState.activeView === 'upload' && !document.getElementById('upload-msg')) {
        showUploadCard(savedState.pendingUploadPrompt || window._pendingUploadPrompt || '');
      }
      const input = document.getElementById('userInput');
      if (input && savedState.draftText) {
        input.value = savedState.draftText;
        autoResize(input);
      }
      return;
    }
  } catch (e) {}
  addAgentMessage(
    'こんにちは！RENOへようこそ。\nどのお部屋をリフォームしたいとお考えですか？',
    null, null,
    ['リビング', 'キッチン', '浴室・洗面所', '寝室', '玄関']
  );
}

window.addEventListener('beforeunload', persistCurrentChatState);
window.addEventListener('pagehide', persistCurrentChatState);

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function scrollBottom() {
  const c = document.getElementById('chat');
  c.scrollTop = c.scrollHeight;
}

const AGENT_ICONS = [
  // female: id f1=通常, f2=笑顔, f3=思考中（横顔）
  { id:'f1', type:'img', src:'data:image/jpeg;base64,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', label:'女性（通常）' },
  { id:'f2', type:'img', src:'data:image/jpeg;base64,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', label:'女性（笑顔）' },
  { id:'f3', type:'img', src:'data:image/jpeg;base64,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', label:'女性（横顔・思考中）' },
  // male
  { id:'m1', type:'img', src:'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCACgAKADASIAAhEBAxEB/8QAHQAAAQQDAQEAAAAAAAAAAAAAAAEEBgcCAwUICf/EAD4QAAEDAwIEBAQDBgUDBQAAAAECAwQABREGIRIxQVEHEyJhFDJCcVKBkQgVI2KhwSQzcrHRFjThJlNjkvD/xAAXAQEBAQEAAAAAAAAAAAAAAAABAAID/8QAHhEBAQACAwEBAQEAAAAAAAAAAAECESExQRJRYQP/2gAMAwEAAhEDEQA/APX4ooorDQoooFSHOkHKsX3UMp4lqxnkOprSBKf3H+HbP5qNFq03uuNtDLjiUfc701XNB2YYed9wMCnDcVhv1cHGv8S9zWZ/Si7M0apXOX8sdpA/mVmtvlzsZywPyraFJSCpRAA5k9KiGo/FLRVinC3y70y7NJ4fh4/8Ree221UnHa2kizPT0YVQh6UP8yLn3Qqoc14r6MXJQxKmP29S/l+Ka4Qf0zUwsl1td1aL9suEaY2nYqZcCsfftRMbs7/hw3IZOyiWz2WMVuJGMg5Hes3EoWjCkpUPcUyXHKFFUZ1TR7HdJrV3BqU4oFNkSihYblo8snksbpP/ABTraqXYs0KKKDShRmiipCgUo50CpDlWl94hflMp43j06J9zSSXVJUGGcF5ffkkdzWcZtLCOFPqUd1KPNRrNu+joR46UK8xxXmOn6j0+1OKwzTK+XSFZ7VJudwfSxFjNlx1xRwEgUwdt8+XGhRlypb7TDLYytxxQSlI9zVVag8edHQZyotvZm3fgOFuxk4bB9iedUf4m68umvr0XJDzrNoQcw7eFFKODo673J6Co62PMSEx20lIGxUMA/YVm5a6amO068WfG+XqdTdp0yiXb4KE5lFZ4XHFnknI+mqvQgMzS+Uf4nPEpz6knvnnn2rfMjvt3Zl9wx8KbKfMR8qSOWfemoU8Gvi3pTMOOSQ2t3dSv5sdzRvbUmj597ziDMVJIVzW4orH555V0dN3K8aWmpuWnrg5FX9XlHKVj3TyNcy3qktLStb6ZTC/rT0/5p4+x5DgXEKRxDiLOfSsdSnsaC9A+FnjhGvEhi0apSzDmOngZloOGXldj+FVXQlQVuDXgqSlstqkITxNL9LyORB/sod6uTwQ8Vb5brhG01qXNxthQBFng/wAVpHQOdwO9al2zZp6UKErSUrSFJPMGmq0LiAqaCnGPqR1T7iniClbYWghSVDII6ikNNjErW24h1sLbUFJPI1lTV1tcdxUhhJKTu42OvuPenLa0uIC0HiSobGqXxWMqSjNLWkUVhIdSy0Vnc8gO57VmKao/xEwrO7bPpT7q6mi1SNkRlTaStw5dc3We3tW7G9ZD70uNqNKtdebf2otY/va4taIt7p+EjLS9clpP+Yv6Wv13P2q8tb6ptWmtNzrtKmNBMZs7JWCrixyx3rxlIuruobzMvSmyj4hw+SDz91Gq8RrGbN328ufD568TxHU9E04CQt0NlwhCR6gjbJ7fatDja28NNqIWo54jzHdR/tWUdh1bbjbGfMcUGWvuTjP3rm25twuNvWsxXIpLKV4LiFHiJH8o6VyL23Kmv/GqjvusAhtlQbJQnsB/NXtXwo8KtL6RsEdtVtjTbg42FyZUlsLUpRGSBnkBnFTlmx2VtjyGrTAQ1x8fAGE44u+Mc63MWbk+d+nJbkTUCLe82/HYkZQW3kFJC+hGeVSwhb0dSFbPMry37KH/ADXsDxQ0TZNQaSuLSrZEExLJcYeS0AtK07ggivIC3R5+F4St5Ocd1geoUZTRxuzJ5aZD7b8VeCoYcHQkfSRT+G/IhpakxiUOtfxG/fuk+x5UzQgtv+a23zwXUj6k9x7iui8pbbsUnJBJRy2ORtQXqP8AZ+1ozqrRZZXlM23OeQ82rmAd0n89/wBKsbO9eJPDzU2qdFa7cmWIMy4S2k/Fw3lcPE0SACD3STz7GvYukpN3mWZqTe48aPLcJJbYXxICM+kg9cjFdN7jlZp1qalPwr/En/IcO4/Crv8AY07xWLiEuIUhQylQwaLDKWitMRauFTLhyto4J7joa2nemXYvDXMdLUZa0/N8qfuayjNeSwhvqBv960yPXMYaPIZWqnXvR6fBSjOaKUc6go/9pywxXNKvotUFkXCWrzpDhPytp+ZQHevPcXg8pDMUcLSUAAjmo/hFXh+1/d51mZgOtR3HI02OuKVp5IUe9UMzKbVGCslKPLSlPDzyeeKM28HQbZCV8RUFY3Wc53HSnOjeIar03Ecb4ky7ihSie4VmuYl+KmIptn+Ej5EpJ3T3JPUmpHoa/wCjYD1lnXSW8bmmf5jhS0VJjMo5YHUmsztqvaJRwqVjlmlztVWI8ffDJb/lLvb7JUfmcjKAqw7DdrZfLeifaZzMyMselxpWRWrHONt1cDdsluKOyGFk/oa8GTo02TcGrg20oMsuOyEHpwFwgk+1e7tSI/8AT1yyoDMVwZJwPlNeVbVddF2iPpZV5u7KUSocq23JkeosBRJSsj2OKtXRnaGqZUE8SMJdQribzyUDzT+dNZnHJjpbZcUQ2sKCAcLQfw0tzudqYluQU3VuW2w7wJkMg8K0fSr9KbXIseUxNDiVZUEl5CtnE8gT71htvtD7kLVdqfys+Y78MsODdSHNgD9jivdNhjrh2aDEcOVsR221H3CQK8CyHFC4QY7SnXX3JiTFJ5tqBGEk9s4r3NoG7XW8WUPXmyP2qW0Q24lw5S6oDdaP5SeVbnTGXaRHlRRRSyayj5Uhp/6T6F/boac1rlt+bGcTjcpyPuN6SK55sZtw8ynf71Ts+MGfVcXl9EpCRTmm0PeRKP8A8mKc0RZFrHesqDSEH8ZrAu/6HlMtstvOxwXkIWNjgb14ltTN2uUZ2ParZKmSICnC82ygqLaB9Sq+hsyKzMhvRJAy08goWO4NU1o7RDGndXaktxPwrc1TbzSY5wXmQCkpJ/PeqwyvMVmZbul4twlyYrdtIBkFLv8AECQfUnH4idq9Aruul9H3Jy+3aC245Hi+XAtUCMHFRGfxvHGyj796jnh54cwbd4wansqLeyYkqOqRC4xxFpaTnb86vZnTtlvmmJ8RyAywu5NFmeW04WV4wSTzrH1puqet/jB4baluCIVy0tMhJcIAkCOFhOeqgOlW1ZX7To4MMRGmX7dch5sdcRv1KOOqRz261xdCeDFi07dIM34lcowUrSwgtAA8X4+fFUtes8aRq+1rgK8hm0oVxoQPR6hjh++9a3+Mmmob/a71E/cLlulqXN9CEPJLSVfnVO6sT4M6OL9n1Qhm5XWQMOtw4/Etn8wNse9XdrSAlV4sdzcUQ1Fk4X2APWon4k+DuntXXONc1o+GfZcLjiEelMgn8R51jLe2pZIqe023QGvoaIFmcYmORgUsrS18NMQkA/Mk4DmPbNVXdLNNhIdaVHbVGDrkNtLasrUrffg55616t094U2m3WW3WpYSgW2V8VHksnheQrOcFXVP3quNM6atl78bdW3qOgtoZe8qE+PlQ+RhSwORwaOjOVTeF9pN81vblyUrRbbYlJnyFIJS3g8j7navdkRbKo7a2DlpSAW/9ONqq/wAJdCot1wc1M1cMG4hQuMUNgtPupOA4O1WkAAAAAAOldZxHO81lSdaM0uagBzprb9m3G/8A23CP706prFGJUtP84P8AQVewzoQv+4ljr5lOqbM+m4vpx86QoU5qiopeVGaSoFBzUR19AmNrYv8AbGfPkwkEPMDYvMn5gD+Icx9qlooxmpKs01CkP3OBqdl2I5CQ9/Dl8QDqm1bKaWOhB2qyH7UyuQZLDrkd4/Mpvkv7iqA/argTNMWa3XDTz0uFEl3JDtwaZJ8pSkkEE4+XP9avfR15Zvulbbd2FpWmVGQ5lJ643FUxnVO6dpiSscKpy8dSEgGtkWOzEa8tlOATlR6qPc1tUvGabS2/iGeDjcQCQeJs4NYt10e2yWw1MZUw+gLaUMKBpmiHc4jQajyGpDSdkh4eoDtnrTlLKhJS95jmAjh4Pp+/3p0ldMsqvCP3CPdHmFmY4yxGQkqcS0fUsAZxnoKqzTbNwt9t9MFEWVPnOOW9vYrfKycHHRAByTVoeJD0lOmHYduWEz56hGjn+ZXM/oDTfSOkxaXETLjLNxuLbCY6HlJwlttIxwpHTPU0/C+nY09bk2qzRYCVcXkowVd1Hcn9TXQxRjajlWtskoFA70tCFNY3/eyz04h/sKdDGaaQPUX3D9Tpx+W1HsM6ZP8AolsPdD6FH70661plN+awpA580/cURnfNZSvryP3p6q8bjikoxRUBWScZpOVJSnH15puHqzSs+wzFFDUtsoC0jJQehFVx4LvjRmk0WO4LWY0We7EXIJylCs+lR7A1bxWcjfrUJ0XDZlp1FHfaQ4y9cFBSFjKVDB2NGV4MiXvNNTIq2l+pp1GDwq5g9iK4jOmUWqEEQZN0WhHyth8KI/UVy4r03Rz/AJSkPy7FxYxupyF/dTf+1TeFLjS46H4rzb7SxlKkKyCKzjhMo1crKjDFmlzw4Xp15hpxjBcSCfttXWhMx7JaEtLkueRHQSp6Q5k46lRrpTJDMWOt+Q4lpptJUtajgJFVZfZUzW+obHDy5G03IkrJaOUrnBtJVxK7N5HLrTMJBcrUg06JOp9RI1NJQtu2RQUWtlWxczzeI/oPzqaHFa2mktNpQ2kJSkAJA2AA5Csq1WRmjnQKWhEFGaWkqTB9YbZW4fpSTWq3oKIbaTzI4j+e9YXDLhaig7uKyr/SKdDHQYqnNPhf96ag/DzCk7NPbj2VTkVhIaDzRbVtnkex705TYlbOtLim8R5SwWXdnm9lfzDuK370bRc0cOaxBqOat1QIDiLPayiReZOzbYOQyOri+wFKMdfalctiv3fb5DLEoI82RIWnjTFb/ER1J6CtPgq1JOlX35kkypDs94rdKcceDscdKjGmNMr1LY9YxXzIS/IdDBlrV63nEjPEOyd8AVYXh2mGzpSJEithpUZPlPt9UuD5s/c1aW3YlsJdAGwWRse9Q+VpmMxcVS4rk22PqOVGI6UtrPcp5GpusBRGenKsVIChggEdjXPLH8bl/ULGn25khPx1wuNyAOUsvu/ws9ykc60ayujVg1ppxb8dx2OGXQ442NmBwn1Y7VNkttNuEISEqxk4HSqp8cLsqwap0ndVt+bHcddiOJxkK40EYP61YcdrLnpbLLzbzCHmlpWhaQpKgdiDyNKarTSmp3NPXGRpy/NpZgR3UohTUqylKFjKUOfhOc4NWU2QtIUkhSSMgg5BrfrDKlwaXhpMU6RPtQSAMnYDc0cqayVl934VB9I3dV2Hai3SkEUea4uWr6vSgHon/wA05pAMAADAHIUvKmTSt2BS0nWlpTRKYLgS40rgeR8iv7H2riX/AFZEs4aZehzJE535IsdoqUr3zyA9zUizTW4wm5be54HEj0uAbj2+1Zs9hn5VfX+86tlWqXMdeZsEZtoqSyzh2QrsCr5U/ka5+kLa1bLe27ha5kpKXpb7q+Nx1R39Sj0HautrK3z/AN3qg8G7ziUlwfLwg7mtiUAE8PyjYfauf3a6fMnR94auFq4X2CDykJe/+wH/ABT++xZVnup1BbW1OsuAC4Rkc1pHJxI/EP8AauPpd34LXSkEgJuUXbJxlSO1TxXq5V0+tYxzs5NoE2PPiNy4jyXWXBlKgef/AJp0k1GZ1tmWWU7dLK2HGFnilQc4Cu60dle3Wuta7zbLkUoiykKdUjj8on1AUaWz9wDJUBvjnUC8RocW83zTdldjtSHFTficLAPlob9RV+eMVNrjLjwYTsqU6G2W05Uo/wD7nUf0dGXcrjK1RMaLbkhPkxWlKBLTIOdx0JO9Ex3TvTgawgsnXhjvsNuRLtbVIW2oZSstkYBH2NcXTqL9oy7/ALvtl1+KtMrJhQp6iQhY5toc5jbkDtUi8W57dquuk5jicNruQjrX+ELSf7gUz1LFblW5cdx5DDiDxsOKUAUOp3SR33pzvzeDjzHaZ8QIsdwNX+1zbUo7eaU+ayT/AK05A/OpVbrhBuUcSLfLYlMn62lhQ/pVd2WYu5WiPLeZW0p1H8RpxPyqGx2P2z+dP7VpliVcGp8VDtvW2oFT0Zfl8fsRyI/Kif6bulcONppJeV5nkMbunmeiB3NZMMpZRwp3PMk8ye9ZttttpIQnGdyeppa1J6xsCgd6DSVpFoooqQo60UuKkwcbQ6gocSFoPMEbVxLnYMtOKtziW3SPSlzdOa7ooIrNxlMtioNSacnwrtY74l2Q5dI01PE4VHg4DzSEjYA1bNrktzYiJCAU52Uk80kcxW1baFp4VpCh2IrQmIy2SWeJkqOTwHGaJLOFuVx9ZSTKlQ9OR3FoXNJXJWg4U2yn5jnpmmd3spYtb0yEmM29Aw9BUwnhVwAbpX3zXYbtIZuj1zbdSuS62GytxOSEjoKykR5bnHj4YKWgtlWDuntT9fxa/qNwpaNXSBcXOP8Ad8MjyGk/K68BlRIPMA7CtWmpJtGuFQA07HiXeMZTbTiuIpeSfVue4ycV1dL6cesFlbtceQ26hC1r43ASo8RzTuTYm5kmNJmOhbkVXGypCMFB9jWd38Op+uR4qW5u+QYttUkKUOKQjuFIGR/WuXGs3/VFlgOTYCi+WkLVx5SWnMDJB+9TgQY/mBxaC6sclLOaeIGAABgdhVZcrypZJw4ll02iIjM2U5LXnJ4zn7V3AkJASkAAcgKyzSda1MZOhbb2BRRRWgKSloqT/9k=', label:'男性（通常）' },
  { id:'m2', type:'img', src:'data:image/jpeg;base64,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', label:'男性（笑顔）' },
  { id:'m3', type:'img', src:'data:image/jpeg;base64,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', label:'男性（相談中）' },
  { id:'logo', type:'img', src:'data:image/jpeg;base64,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', label:'RENOロゴ' },
];
// 感情→アイコンID マッピング（female選択時）
// f1:通常, f2:笑顔, f3:思考中
// male選択時は常にm1
// 初期アイコン
function normalizeAgentIconId(value) {
  const id = String(value || '').trim().toLowerCase();
  const aliases = { female: 'f1', male: 'm1', default: 'f1' };
  const normalized = aliases[id] || id;
  return normalized === 'none' || AGENT_ICONS.some(icon => icon.id === normalized)
    ? normalized
    : 'f1';
}

let _agentIconId = normalizeAgentIconId(safeLocalGet('reno_agent_icon', 'f1'));
safeLocalSet('reno_agent_icon', _agentIconId);
// 現在の表情 (f1/f2/f3 or m1 or none)
let _currentIconId = normalizeAgentIconId(_agentIconId);

// 感情タイプ → female表情マッピング
const EMOTION_MAP = {
  normal:   'f1',   // 通常応答 → 正面
  happy:    'f2',   // 完了・喜び → 笑顔
  thinking: 'f3',  // 考え中・提案 → 横顔
};

function getIconForEmotion(emotion) {
  const base = _agentIconId || 'f1';
  if (base === 'logo') return 'logo'; // ロゴは常に固定
  // male系
  if (base === 'm1' || base === 'm2' || base === 'm3') {
    const maleMap = { normal:'m1', happy:'m2', thinking:'m3' };
    return maleMap[emotion] || 'm1';
  }
  // female系
  return EMOTION_MAP[emotion] || EMOTION_MAP.normal;
}

function getAgentIconHTML(iconId) {
  const id = normalizeAgentIconId(iconId || _currentIconId || 'f1');
  if (id === 'none') return null;
  const ic = AGENT_ICONS.find(i => i.id === id);
  if (!ic || ic.type !== 'img') {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`;
  }
  return `<img src="${ic.src}" alt="agent">`;
}

function refreshAgentAvatars() {
  const id = normalizeAgentIconId(_currentIconId || _agentIconId || 'f1');
  const icon = AGENT_ICONS.find(item => item.id === id);
  if (!icon) return;
  document.querySelectorAll('.avatar.agent img').forEach(img => {
    img.src = icon.src;
  });
}
// Compat alias
Object.defineProperty(window, 'agentIcon', { get: () => getAgentIconHTML() });
const userIcon  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

function removeSuggestions() {
  const el = document.getElementById('suggestions-row');
  if (el) el.remove();
}

function renderSuggestions(chips) {
  removeSuggestions();
  // 担当者相談とPDF保存は最終確定時だけ表示する
  const available = (chips || []).filter(label =>
    label !== '担当者に相談' && label !== '提案書を作成'
  );
  if (available.length === 0) return;
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'suggestions'; div.id = 'suggestions-row';
  available.forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = label;
    btn.onclick = () => {
      removeSuggestions();
      tapChip(label);
    };
    div.appendChild(btn);
  });
  chat.appendChild(div);
  scrollBottom();
}

function tapChip(text) {
  playSound('chip');
  // APIが候補タグを返さない場合にも使える基本操作。
  if (text === '写真をアップロード') {
    showUploadCard('現在の状態を確認するため、部屋の写真を選択してください');
    return;
  }
  if (text === '概算を見る') {
    showSimulator();
    return;
  }
  if (text === '相談を続ける') {
    document.getElementById('userInput')?.focus();
    return;
  }
  if (text === '📷 写真を撮る・選ぶ') {
    showUploadCard('リフォームしたいお部屋の写真を選んでください');
    return;
  }
  if (text === 'もう一度試す') {
    if (window._beforeFile || window._beforeURL) {
      addUserMessage(text);
      generateWithFiles(window._beforeFile, null);
    } else {
      addUserMessage(text);
      showUploadCard('施工後イメージを作成するため、現状写真を選んでください');
    }
    return;
  }
  if (text === 'もう一度送る') {
    const lastUser = [...history].reverse().find(message => message.role === 'user');
    if (lastUser) callAgent();
    else addAgentMessage('先に相談内容を入力してください。');
    return;
  }
  if (text === '担当者に相談') {
    addAgentMessage('担当者への相談は、概算と提案内容を確認してから最後に一度だけ申し込めます。', null, null,
      ['概算を見る', '相談内容を続ける']);
    return;
  }
  if (text === '相談内容を続ける') {
    addAgentMessage('このまま相談を続けられます。次に確認したいことを入力してください。');
    document.getElementById('userInput')?.focus();
    return;
  }
  if (text === '別の部屋を相談する') {
    const response = getTemplateActionResponse('choose-room', history);
    addTemplateTurn(text, response.reply, response.suggestions);
    return;
  }
  if (text === '別の箇所も試す') {
    const response = getTemplateActionResponse('choose-part', history);
    addTemplateTurn(text, response.reply, response.suggestions);
    return;
  }
  if (text === 'スタイルを変えてみる') {
    const response = getTemplateActionResponse('change-style', history);
    addTemplateTurn(text, response.reply, response.suggestions);
    return;
  }
  if (text === '素材を探す' || text === '素材提案' || text === '別の素材を見る') {
    addUserMessage(text);
    showMaterial('composite');
    return;
  }
  if (text === '概算を見る' || text === '概算見積もり') {
    addUserMessage(text);
    showSimulator();
    return;
  }
  if (text === '施工後イメージ') {
    if (window._beforeFile || window._beforeURL) {
      addUserMessage(text);
      generateWithFiles(window._beforeFile, null);
    } else {
      addUserMessage(text);
      showUploadCard('施工後イメージを作成するため、現状写真を選んでください');
    }
    return;
  }
  if (text === '昼/夜を見る') {
    if (window._lastAfterSrc && window._lastBeforeSrc) {
      addUserMessage(text);
      generateNight(null, window._lastAfterSrc, window._lastBeforeSrc);
    } else {
      addAgentMessage('昼夜の比較には、先に施工後イメージを作成してください。', null, null,
        ['施工後イメージ', '概算を見る', '担当者に相談']);
    }
    return;
  }
  if (text === '画像で確認する') {
    if (window._beforeFile || window._beforeURL) {
      startGenerationFromPhoto(text);
    } else {
      addUserMessage(text);
      showUploadCard('施工後イメージを確認するため、現状写真を選んでください');
    }
    return;
  }
  if (text === 'このスタイルで進めたい') {
    addUserMessage(text);
    showUploadCard('施工後イメージを作成するため、現状写真を選んでください');
    return;
  }
  if (text === '提案書を作成') {
    addUserMessage(text);
    addAgentMessage('提案書のPDFは、概算と内容を最終確定した後に一度だけ作成できます。', null, null,
      ['概算を見る', '相談内容を続ける']);
    return;
  }
  addUserMessage(text);
  history.push({ role:'user', content: text });
  callAgent();
}

function addAgentMessage(text, afterSrc = null, beforeSrc = null, suggestions = null) {
  const safeAfterSrc = safeImageSrc(afterSrc);
  const safeBeforeSrc = safeImageSrc(beforeSrc);
  // 感情判定してアイコン切替
  let emotion = 'normal';
  if (safeAfterSrc && safeBeforeSrc) {
    emotion = 'happy';      // 画像生成完了 → 笑顔
    playSound('complete');
  } else {
    // テキスト内容で感情判定
    const happyWords = ['完成','できました','いかがでしょ','ありがとう','素敵','すてき','よかった','おめでとう','！'];
    const thinkWords = ['いくつか','提案','考え','どうぞ','さて','では','プラン','おすすめ','ご要望','拝見'];
    if (happyWords.some(w => text.includes(w))) emotion = 'happy';
    else if (thinkWords.some(w => text.includes(w))) emotion = 'thinking';
    playSound('receive');
  }
  _currentIconId = getIconForEmotion(emotion);

  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent';
  const iconHTML = getAgentIconHTML();
  const avatarHTML = iconHTML
    ? `<div class="avatar agent">${iconHTML}</div>`
    : `<div class="avatar agent" style="visibility:hidden;flex-shrink:0;"></div>`;
  let inner = `${avatarHTML}<div class="bubble agent">`;
  inner += escapeHTML(text).replace(/\n/g, '<br>');
  if (safeAfterSrc && safeBeforeSrc) {
    inner += `<div class="compare-pair">
      <div class="ci"><span class="ci-tag before">Before</span><img src="${escapeHTML(safeBeforeSrc)}" alt="before"></div>
      <div class="ci"><span class="ci-tag after">After</span><img src="${escapeHTML(safeAfterSrc)}" alt="after"></div>
    </div>`;
    inner += `<div class="share-bar">
      <button class="share-btn line" onclick="shareViaLine('${escapeHTML(escapeJSString(safeAfterSrc))}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
        LINEで送る
      </button>
      <button class="share-btn copy" onclick="shareNative('${escapeHTML(escapeJSString(safeAfterSrc))}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        共有
      </button>
      <a class="share-btn dl" href="${escapeHTML(safeAfterSrc)}" download="reno-ai.png">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        保存
      </a>
      <button class="share-btn night" onclick="generateNight(this,'${escapeHTML(escapeJSString(safeAfterSrc))}','${escapeHTML(escapeJSString(safeBeforeSrc))}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        昼/夜
      </button>
    </div>`;
  }
  inner += '</div>';
  div.innerHTML = inner;
  chat.appendChild(div);
  if (suggestions) renderSuggestions(suggestions);
  scrollBottom();
}

function addUserMessage(text) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="avatar user">${userIcon}</div><div class="bubble user">${escapeHTML(text).replace(/\n/g,'<br>')}</div>`;
  chat.appendChild(div);
  scrollBottom();
}

function addTyping() {
  _currentIconId = getIconForEmotion('thinking');
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'typing';
  const iconHTML = getAgentIconHTML();
  const avatarHTML = iconHTML
    ? `<div class="avatar agent">${iconHTML}</div>`
    : `<div class="avatar agent" style="visibility:hidden;flex-shrink:0;"></div>`;
  div.innerHTML = `${avatarHTML}<div class="bubble agent"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(div);
  scrollBottom();
}

function removeTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
}

function showUploadCard(prompt) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'upload-msg';
  window._pendingUploadPrompt = prompt;
  persistChatState('upload');
  const thumbs = SAMPLE_IMAGES.map((s,i) =>
    '<div class="sample-thumb" onclick="useSampleImage(' + i + ')">' +
    '<img src="' + s.src + '" alt="' + s.label + '">' +
    '<div class="sample-thumb-label">' + s.label + '</div></div>'
  ).join('');
  div.innerHTML = '<div class="avatar agent">' + getAgentIconHTML() + '</div>' +
    '<div class="bubble agent">' +
      '<div class="upload-card" onclick="document.getElementById(\'photoInput\').click()">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
        '<div class="upload-card-text">📷 自分の写真をアップロード</div>' +
      '</div>' +
      '<div class="sample-picker">' +
        '<span class="sample-picker-label">または サンプル画像で試す</span>' +
        '<div class="sample-grid">' + thumbs + '</div>' +
      '</div>' +
      '<input type="file" id="photoInput" accept="image/*" style="display:none" onchange="handlePhoto(event)">' +
    '</div>';
  chat.appendChild(div);
  scrollBottom();
}

async function useSampleImage(idx, prompt = window._pendingUploadPrompt || '') {
  const sample = SAMPLE_IMAGES[idx];
  const beforeURL = sample.src;
  const card = document.getElementById('upload-msg');
  if (card) card.remove();
  addUserMessage('📷 サンプル画像（' + sample.label + '）を選択しました');

  // サンプル画像をFileオブジェクトに変換してからglobalに保持
  try {
    const res0 = await fetch(sample.src);
    const blob = await res0.blob();
    const file = new File([blob], 'sample.jpg', { type: 'image/jpeg' });
    window._beforeFile = file;
    window._beforeURL = beforeURL;
    window._genPrompt = prompt;
    await persistPhotoUpload(file);
  } catch(e) {
    window._beforeFile = null;
    window._beforeURL = beforeURL;
    window._genPrompt = prompt;
  }

  // 理想イメージカードを表示（handlePhotoと同じフロー）
  showIdealImageCard(window._beforeFile, beforeURL, prompt);
}
async function handlePhoto(event, prompt = window._pendingUploadPrompt || '') {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await persistPhotoUpload(file);
  } catch (e) {
    alert('写真の保存に失敗しました: ' + e.message);
    return;
  }
  const beforeURL = URL.createObjectURL(file);

  const card = document.getElementById('upload-msg');
  if (card) card.remove();
  playSound('upload');
  addUserMessage('📷 写真をアップロードしました');

  // 理想イメージ追加カードを表示
  showIdealImageCard(file, beforeURL, prompt);
}

function showIdealImageCard(beforeFile, beforeURL, prompt) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'ideal-msg';
  div.innerHTML = `
    <div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      <div style="font-size:13px;margin-bottom:10px;">この写真をどう使いますか？<br><span style="font-size:11px;color:var(--muted);">状態を診断してから素材を探すことも、すぐに施工後イメージを作ることもできます。</span></div>
      <div style="display:flex;gap:8px;">
        <div class="upload-card" style="flex:1;border-color:var(--gold);background:var(--gold-bg);" onclick="startPhotoDiagnosis()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/><path d="M8 3.5 6.5 2M16 3.5 17.5 2"/></svg>
          <div class="upload-card-text">状態を診断する</div>
        </div>
        <div class="upload-card" style="flex:1;" onclick="document.getElementById('idealInput').click()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <div class="upload-card-text">理想の画像を追加</div>
        </div>
          <div class="upload-card" style="flex:1;border-color:var(--border);" onclick="startGenerationFromPhoto('診断せず施工後イメージを作る')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          <div class="upload-card-text" style="color:var(--muted);">診断せず生成する</div>
        </div>
      </div>
      <input type="file" id="idealInput" accept="image/*" style="display:none" onchange="handleIdealPhoto(event)">
    </div>`;
  chat.appendChild(div);
  scrollBottom();

  // グローバルに保持
  window._beforeFile = beforeFile;
  window._beforeURL = beforeURL;
  window._genPrompt = prompt;
}

function startPhotoDiagnosis() {
  const card = document.getElementById('ideal-msg');
  if (card) card.remove();
  addUserMessage('🔎 この写真の状態を診断する');
  addTyping();
  window.setTimeout(() => {
    removeTyping();
    const beforeURL = window._beforeURL || '';
    const chat = document.getElementById('chat');
    const div = document.createElement('div');
    div.className = 'msg agent';
    div.innerHTML = `
      <div class="avatar agent">${getAgentIconHTML()}</div>
      <div class="bubble agent" style="max-width:88%;">
        <div style="font-size:13px;font-weight:600;margin-bottom:9px;">状態診断結果（デモ）</div>
        ${beforeURL ? `<img src="${beforeURL}" alt="診断した写真" style="width:100%;height:130px;object-fit:cover;border-radius:8px;margin-bottom:10px;">` : ''}
        <div style="padding:9px 0;border-bottom:1px solid var(--border);"><strong>壁紙（クロス）</strong><br><span style="font-size:11px;color:var(--muted);">継ぎ目の浮き・黄ばみが見られます</span><span style="float:right;color:var(--gold);font-size:11px;">経年劣化 中</span></div>
        <div style="padding:9px 0;border-bottom:1px solid var(--border);"><strong>床材</strong><br><span style="font-size:11px;color:var(--muted);">複合フローリング（推定）・細かな擦り傷</span><span style="float:right;color:var(--green);font-size:11px;">軽度</span></div>
        <div style="padding:9px 0;"><strong>建具（ドア枠）</strong><br><span style="font-size:11px;color:var(--muted);">日焼けによる色あせが目立ちます</span><span style="float:right;color:#c05040;font-size:11px;">劣化 大</span></div>
        <div style="font-size:11px;color:var(--muted);line-height:1.6;background:var(--bg);padding:9px 10px;border-radius:7px;">💡 壁紙の張替えと建具の再塗装を優先すると、費用対効果が高そうです。</div>
        <div style="display:flex;gap:7px;margin-top:10px;">
          <button class="chip" type="button" onclick="startCatalogFromDiagnosis()">素材を探す</button>
          <button class="chip" type="button" onclick="startEstimateFromDiagnosis()">概算を見る</button>
          <button class="chip" type="button" onclick="startGenerationFromPhoto()">施工後イメージ</button>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:8px;">※ AIによる参考判定です。現地確認で結果が変わる場合があります。</div>
      </div>`;
    chat.appendChild(div);
    scrollBottom();
  }, 1100);
}

function startCatalogFromDiagnosis() {
  addUserMessage('素材を探す');
  showMaterial('composite');
}

function startEstimateFromDiagnosis() {
  addUserMessage('概算を見る');
  showSimulator();
}

function startGenerationFromPhoto(label = '施工後イメージ') {
  addUserMessage(label);
  generateWithFiles(window._beforeFile, null);
}

function getHandoffSummary(context) {
  const rows = [`相談の起点：${context}`];
  const material = MATERIALS[window._selectedMaterialKey];
  if (material) rows.push(`選択素材：${material.name}`);
  if (simState.items.size) {
    const estimate = calcCost();
    const items = [...simState.items]
      .map(k => COST_DATA.items.find(item => item.key === k)?.label)
      .filter(Boolean).join('・');
    rows.push(`概算：${COST_DATA.sizes[simState.sizeIdx].label}・${items}・${COST_DATA.grades[simState.gradeIdx].label}で${fmtMoney(estimate.lo)}〜${fmtMoney(estimate.hi)}`);
  }
  if (window._beforeURL) rows.push('現状写真：アップロード済み');
  if (window._lastAfterSrc) rows.push('施工後イメージ：作成済み');
  return rows;
}

function handoffToStaff(context) {
  if (finalizationState !== 'confirmed' || finalHandoffStarted) {
    addAgentMessage('担当者への相談受付は、内容を最終確定した後に進められます。', null, null,
      ['概算を見る', '相談内容を続ける']);
    return;
  }
  finalHandoffStarted = true;
  removeSuggestions();
  addUserMessage('担当者に相談する');
  document.getElementById('handoff-msg')?.remove();
  const rows = getHandoffSummary(context);
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.id = 'handoff-msg';
  div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      <div class="handoff-card">
        <div class="handoff-title">担当者に相談する</div>
        <div class="handoff-lead">現在の相談内容を確認して、担当者からの連絡を希望する場合は入力してください。</div>
        <div class="handoff-summary">
          <div class="handoff-summary-title">共有予定の内容（デモ）</div>
          ${rows.map(row => `<div class="handoff-summary-row">・${escapeHTML(row)}</div>`).join('')}
        </div>
        <div class="handoff-field">
          <label class="handoff-label" for="handoff-name">お名前</label>
          <input class="handoff-input" id="handoff-name" type="text" placeholder="例：山田 太郎" autocomplete="name">
        </div>
        <div class="handoff-field">
          <label class="handoff-label" for="handoff-contact">連絡先（メールまたは電話番号）</label>
          <input class="handoff-input" id="handoff-contact" type="text" placeholder="例：taro@example.com" autocomplete="email">
        </div>
        <div class="handoff-error" id="handoff-error">お名前と連絡先を入力してください。</div>
        <button class="handoff-submit" type="button" onclick="submitHandoff()">この内容で相談を申し込む</button>
        <div class="handoff-note">※ モックでは受付完了までを確認します。実際の担当者への送信はまだ行いません。</div>
      </div>
    </div>`;
  document.getElementById('chat').appendChild(div);
  scrollBottom();
  document.getElementById('handoff-name')?.focus();
}

function submitHandoff() {
  const name = document.getElementById('handoff-name')?.value.trim() || '';
  const contact = document.getElementById('handoff-contact')?.value.trim() || '';
  const error = document.getElementById('handoff-error');
  if (!name || !contact) {
    if (error) error.style.display = 'block';
    document.getElementById(!name ? 'handoff-name' : 'handoff-contact')?.focus();
    return;
  }
  const card = document.getElementById('handoff-msg');
  if (card) card.remove();
  addUserMessage('相談を申し込みました');
  addAgentMessage(`ありがとうございます、${name}さん。担当者への相談を受け付けました。${contact}へ連絡する想定です。`, null, null, ['相談内容を続ける', '別の部屋を相談する']);
  clearDraftCache();
  finalizationState = 'completed';
}

function startProposalFlow() {
  addAgentMessage('提案書のPDFは、概算と内容を最終確定した後に一度だけ作成できます。', null, null,
    ['概算を見る', '相談内容を続ける']);
}

async function handleIdealPhoto(event) {
  const idealFile = event.target.files[0];
  if (!idealFile) return;
  const card = document.getElementById('ideal-msg');
  if (card) card.remove();
  playSound('upload');
  addUserMessage('🖼️ 理想のイメージ画像を追加しました');
  await generateWithFiles(window._beforeFile, idealFile);
}

async function generateWithFiles(beforeFile, idealFile) {
  const card = document.getElementById('ideal-msg');
  if (card) card.remove();

  let bf = beforeFile || window._beforeFile;
  const prompt = window._genPrompt || '';
  const beforeURL = window._beforeURL || '';

  addTyping();

  try {
    // サンプル画像の変換に失敗しても、保持しているURLから再構成して処理を継続する
    if (!bf && beforeURL) {
      const source = await fetch(beforeURL);
      const blob = await source.blob();
      bf = new File([blob], 'before.jpg', { type: blob.type || 'image/jpeg' });
    }
    if (!bf) {
      removeTyping();
      showUploadCard('施工後イメージを作成するため、現状写真を選んでください');
      return;
    }

    const form = new FormData();
    form.append('token', sessionToken);

    // 理想画像がある場合はプロンプトに指示を追加
    if (idealFile) {
      const enhancedPrompt = prompt + ' Apply the interior style, materials, colors, and design aesthetic from the reference style image to this room. Keep the room structure and layout exactly the same. Photorealistic interior design.';
      form.append('prompt', enhancedPrompt);
      form.append('image[]', bf, bf.name);
      form.append('image[]', idealFile, idealFile.name);
    } else {
      form.append('prompt', prompt);
      form.append('image', bf, bf.name);
    }

    const res  = await fetchWithTimeout(EDGE_URL, { method:'POST', headers: EDGE_HEADERS, body: form }, 90000);
    const data = await res.json();

    if (res.status === 429 && data.error === 'limit_exceeded' && !DEMO_BYPASS_LIMIT) {
      removeTyping();
      showUpgradeModal();
      addAgentMessage('今月の生成回数に達しました。プランのアップグレードをご検討ください。', null, null,
        ['概算を見る', '担当者に相談', '相談内容を続ける']);
      return;
    }

    if (!res.ok) throw new Error(data.error?.message || data.error || '生成に失敗しました');

    const img = data.data?.[0];
    const src = img?.url || (img?.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
    if (!src) throw new Error('画像の取得に失敗しました');

    window._lastAfterSrc = src;
    window._lastBeforeSrc = beforeURL;

    if (data._usage) updateUsageAfterGen(data._usage);

    removeTyping();
    const msg = idealFile
      ? '理想のイメージを参考にした施工後のイメージが完成しました！✨'
      : '施工後のイメージが完成しました！いかがでしょうか？✨';
    addAgentMessage(msg, src, beforeURL,
      ['別の箇所も試す', 'スタイルを変えてみる', '昼/夜を見る', '概算を見る', '提案書を作成']
    );
    history.push({ role:'assistant', content: msg });
    persistChatHistory();

  } catch(e) {
    removeTyping();
    // フォールバック：サンプル画像でビフォーアフターを表示
    const fallbackSrc = await getFallbackImage(window._genPrompt || '');
    const timeoutMsg = '画像生成に時間がかかりすぎたため中断しました。混雑している可能性があります。参考イメージをご覧いただくか、少し時間をおいてもう一度お試しください。';
    const headline = e.isTimeout ? timeoutMsg : '現在AIイメージ生成をご利用いただけません。参考イメージをご覧ください。';
    if (fallbackSrc) {
      // 参考画像も後続の昼夜比較・提案書作成へ引き継げるようにする
      window._lastAfterSrc = fallbackSrc;
      window._lastBeforeSrc = beforeURL;
      addAgentMessage(
        headline,
        fallbackSrc, beforeURL,
        ['もう一度試す', '別の箇所も試す', 'スタイルを変えてみる', '概算を見る', '提案書を作成']
      );
    } else {
      addAgentMessage(e.isTimeout ? timeoutMsg : '現在AIイメージ生成をご利用いただけません。参考イメージを確認するか、別の方法で相談を続けられます。', null, null, ['もう一度試す', '概算を見る', '担当者に相談', '相談内容を続ける']);
    }
  }
}

// エラー時フォールバック画像取得（after_プレフィックスのアフター専用画像）
async function getFallbackImage(prompt) {
  try {
    const p = (prompt || '').toLowerCase();
    let file = 'after_living.jpg';
    if (p.includes('kitchen') || p.includes('キッチン'))                      file = 'after_kitchen.jpg';
    else if (p.includes('bathroom') || p.includes('浴室'))                    file = 'after_bathroom.jpg';
    else if (p.includes('washroom') || p.includes('洗面') || p.includes('脱衣')) file = 'after_washroom.jpg';
    else if (p.includes('bedroom') || p.includes('寝室') || p.includes('子供')) file = 'after_bedroom.jpg';
    else if (p.includes('washitsu') || p.includes('和室'))                    file = 'after_washitsu.jpg';
    else if (p.includes('entrance') || p.includes('玄関'))                    file = 'after_entrance.jpg';
    const res = await fetch(`assets/samples/${file}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch(e) { return null; }
}

// ── Share functions ──
async function srcToBlob(src) {
  if (src.startsWith('data:')) {
    const res = await fetch(src);
    return await res.blob();
  }
  const res = await fetch(src);
  return await res.blob();
}

async function shareViaLine(src) {
  try {
    const blob = await srcToBlob(src);
    const file = new File([blob], 'reno-ai.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: 'RENO リフォームイメージ',
        text: 'AIが生成したリフォーム後のイメージです✨',
        files: [file],
      });
    } else {
      // fallback: LINE URL scheme with text only
      const url = encodeURIComponent('AIが生成したリフォームイメージをRENOで確認しました！');
      window.open(`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(location.href)}&text=${url}`, '_blank');
    }
  } catch(e) {
    if (e.name !== 'AbortError') alert('共有できませんでした: ' + e.message);
  }
}

async function shareNative(src) {
  try {
    const blob = await srcToBlob(src);
    const file = new File([blob], 'reno-ai.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: 'RENO リフォームイメージ',
        text: 'AIが生成したリフォーム後のイメージです✨',
        files: [file],
      });
    } else {
      alert('お使いのブラウザでは共有できません。「保存」からダウンロードしてください。');
    }
  } catch(e) {
    if (e.name !== 'AbortError') alert('共有できませんでした: ' + e.message);
  }
}

// ── Material Database ──
const MATERIALS = {
  oak: {
    name:'オーク無垢材', category:'床材', icon:'🪵', bg:'#1a1510',
    durability:4, maintenance:2, water:2,
    cost:'8,000〜20,000円/㎡', life:'30〜50年',
    water_label:'低め',
    pros:['温かみのある自然な風合い','年月とともに味が出る','断熱・保温効果が高い','研磨で傷を補修できる'],
    cons:['水・湿気に弱い','傷がつきやすい','季節で膨張・収縮する','定期的なメンテナンスが必要'],
  },
  composite: {
    name:'複合フローリング', category:'床材', icon:'🏗️', bg:'#141418',
    durability:3, maintenance:4, water:3,
    cost:'3,000〜10,000円/㎡', life:'15〜30年',
    water_label:'普通',
    pros:['コストパフォーマンスが高い','反りや収縮が少ない','種類・デザインが豊富','施工しやすい'],
    cons:['傷の補修が難しい','無垢材より質感が劣る','耐用年数が短め','シート剥がれの可能性'],
  },
  tile: {
    name:'磁器タイル', category:'床材・壁材', icon:'🔷', bg:'#141520',
    durability:5, maintenance:5, water:5,
    cost:'5,000〜15,000円/㎡', life:'50年以上',
    water_label:'非常に高い',
    pros:['耐水性・耐久性が非常に高い','お手入れが簡単','衛生的','デザインが豊富'],
    cons:['冬場に冷たく感じる','硬いため転倒時に危険','目地に汚れがたまりやすい','施工コストが高め'],
  },
  cushion: {
    name:'クッションフロア', category:'床材', icon:'🟫', bg:'#181510',
    durability:2, maintenance:5, water:5,
    cost:'1,500〜4,000円/㎡', life:'10〜15年',
    water_label:'非常に高い',
    pros:['低コスト','防水性が高い','足に優しい','DIYしやすい'],
    cons:['安っぽく見えやすい','傷みやすく耐用年数が短い','熱に弱い','重家具で凹みが残る'],
  },
  plaster: {
    name:'漆喰', category:'壁材', icon:'⬜', bg:'#181818',
    durability:4, maintenance:3, water:2,
    cost:'3,000〜8,000円/㎡', life:'30〜50年',
    water_label:'低め',
    pros:['調湿・消臭効果が高い','自然素材で健康に優しい','高級感がある','防火性が高い'],
    cons:['施工コストが高い','ひび割れしやすい','汚れが落ちにくい','湿気の多い場所は不向き'],
  },
  vinyl: {
    name:'ビニールクロス', category:'壁材', icon:'📄', bg:'#151515',
    durability:2, maintenance:4, water:3,
    cost:'1,000〜2,500円/㎡', life:'10〜15年',
    water_label:'普通',
    pros:['最もリーズナブル','種類・デザインが豊富','施工が早い','汚れが拭き取りやすい'],
    cons:['質感がプラスチック的','耐用年数が短い','結露でカビが生えやすい','調湿効果がない'],
  },
  concrete: {
    name:'コンクリート打ちっぱなし', category:'壁材', icon:'🧱', bg:'#141414',
    durability:5, maintenance:3, water:3,
    cost:'5,000〜12,000円/㎡', life:'50年以上',
    water_label:'普通',
    pros:['独特のクールな質感','耐久性が非常に高い','個性的な空間に','メンテナンス頻度が少ない'],
    cons:['冬場に寒く感じやすい','結露しやすい','DIYでの補修が難しい','コストが高め'],
  },
  marble: {
    name:'大理石調タイル', category:'床材・壁材', icon:'✨', bg:'#181818',
    durability:4, maintenance:4, water:5,
    cost:'6,000〜20,000円/㎡', life:'30年以上',
    water_label:'非常に高い',
    pros:['高級感が出る','耐水性が高い','本物より低コスト','お手入れしやすい'],
    cons:['本物の大理石より質感が劣る','冷たさがある','滑りやすい種類も','接着が弱いと剥がれる'],
  },
  tatami: {
    name:'畳', category:'床材', icon:'🟩', bg:'#121a12',
    durability:2, maintenance:2, water:1,
    cost:'5,000〜30,000円/畳', life:'10〜20年（表替え5年）',
    water_label:'非常に低い',
    pros:['クッション性・保温性が高い','和の落ち着いた雰囲気','断熱効果がある','香りがリラックスを誘う'],
    cons:['水・湿気に非常に弱い','ダニ・カビが発生しやすい','定期的な表替えが必要','家具の跡がつきやすい'],
  },
};

// mockup.html の素材候補表示に対応する商品情報。価格は材料費の目安（税・施工費別）です。
const MATERIAL_CANDIDATES = {
  oak: [
    {company:'朝日ウッドテック', name:'ライブナチュラル プレミアム オーク', code:'MRX-001', price:'¥18,000〜24,000', unit:'㎡', detail:'本体 ¥18,000〜／㎡ + 施工費 ¥6,000〜10,000／㎡', life:'約30年', cases:'施工実績 12件'},
    {company:'無垢フローリング専門店', name:'オーク無垢 乱尺 15mm', code:'OK-15', price:'¥12,000〜18,000', unit:'㎡', detail:'本体 ¥12,000〜／㎡ + オイル仕上げ ¥2,000〜／㎡', life:'約30年', cases:'施工実績 8件'},
    {company:'イクタ', name:'銘木フロアー ラスティックオーク', code:'IK-RO', price:'¥9,800〜14,000', unit:'㎡', detail:'本体 ¥9,800〜／㎡ + 施工費 ¥5,000〜', life:'約25年', cases:'施工実績 6件'}
  ],
  composite: [
    {company:'DAIKEN', name:'トリニティ ハピアフロア オーク', code:'YB11545', price:'¥12,800', unit:'㎡', detail:'本体 ¥12,800／㎡ + 施工費 ¥4,000〜6,000／㎡', life:'約15年', cases:'施工実績 4件'},
    {company:'Panasonic', name:'アーキスペックフロアーA オーク', code:'KEAV2', price:'¥9,600', unit:'㎡', detail:'本体 ¥9,600／㎡ + 施工費 ¥4,000〜5,000／㎡', life:'約15年', cases:'施工実績 2件'},
    {company:'NODA', name:'カナエルC リアルフィニッシュ', code:'CRS-01', price:'¥8,900〜', unit:'㎡', detail:'本体 ¥8,900〜／㎡ + 施工費 ¥4,000〜／㎡', life:'約15年', cases:'施工実績 3件'}
  ],
  tile: [
    {company:'LIXIL', name:'エコカラットプラス ストーングレース', code:'ECP-630', price:'¥13,500〜', unit:'㎡', detail:'本体 ¥13,500〜／㎡ + 施工費 ¥8,000〜12,000／㎡', life:'約20年', cases:'施工実績 9件'},
    {company:'名古屋モザイク', name:'コラベル ミックス', code:'NMG-01', price:'¥11,000〜16,000', unit:'㎡', detail:'本体 ¥11,000〜／㎡ + 施工費 ¥9,000〜／㎡', life:'約20年', cases:'施工実績 5件'},
    {company:'平田タイル', name:'ブリックタイル アンティーク', code:'HT-ANT', price:'¥7,800〜', unit:'㎡', detail:'本体 ¥7,800〜／㎡ + 施工費 ¥7,000〜／㎡', life:'約20年', cases:'施工実績 4件'}
  ],
  cushion: [
    {company:'サンゲツ', name:'ノンスリップクッションフロア', code:'HM-11000', price:'¥3,500〜5,500', unit:'㎡', detail:'本体 ¥3,500〜／㎡ + 施工費 ¥2,500〜4,000／㎡', life:'約10年', cases:'施工実績 10件'},
    {company:'東リ', name:'クッションフロア 住宅用', code:'CF-9600', price:'¥3,000〜5,000', unit:'㎡', detail:'本体 ¥3,000〜／㎡ + 施工費 ¥2,500〜／㎡', life:'約10年', cases:'施工実績 7件'},
    {company:'リリカラ', name:'抗菌・防カビ クッションフロア', code:'LH-81300', price:'¥3,800〜', unit:'㎡', detail:'本体 ¥3,800〜／㎡ + 施工費 ¥2,500〜／㎡', life:'約10年', cases:'施工実績 5件'}
  ],
  plaster: [
    {company:'珪藻土メーカーA', name:'自然素材の珪藻土 standard', code:'KS-01', price:'¥6,000〜9,000', unit:'㎡', detail:'材料 ¥6,000〜／㎡ + 左官施工費 ¥7,000〜10,000／㎡', life:'約30年', cases:'施工実績 8件'},
    {company:'四国化成', name:'けいそうリフォーム', code:'KSR-20', price:'¥4,800〜7,500', unit:'㎡', detail:'材料 ¥4,800〜／㎡ + 施工費 ¥6,000〜8,000／㎡', life:'約20年', cases:'施工実績 6件'},
    {company:'日本プラスター', name:'漆喰うま〜くヌレール', code:'UM-02', price:'¥3,900〜', unit:'㎡', detail:'材料 ¥3,900〜／㎡ + DIY対応', life:'約20年', cases:'施工実績 5件'}
  ],
  vinyl: [
    {company:'サンゲツ', name:'SP 壁紙 スタンダード', code:'SP-9700', price:'¥1,500〜2,500', unit:'㎡', detail:'材料 ¥1,500〜／㎡ + 施工費 ¥1,000〜1,500／㎡', life:'約10年', cases:'施工実績 14件'},
    {company:'リリカラ', name:'ベース 量産クロス', code:'LB-9200', price:'¥1,200〜2,000', unit:'㎡', detail:'材料 ¥1,200〜／㎡ + 施工費 ¥1,000〜／㎡', life:'約10年', cases:'施工実績 11件'},
    {company:'東リ', name:'パワー1000 消臭タイプ', code:'WVP-400', price:'¥1,800〜3,000', unit:'㎡', detail:'材料 ¥1,800〜／㎡ + 施工費 ¥1,000〜／㎡', life:'約10年', cases:'施工実績 7件'}
  ],
  concrete: [
    {company:'カラーワークス', name:'モールテックス ベーシック', code:'MTX-01', price:'¥18,000〜28,000', unit:'㎡', detail:'材料 ¥18,000〜／㎡ + 施工費 ¥12,000〜／㎡', life:'約30年', cases:'施工実績 4件'},
    {company:'フッコー', name:'デザインコンクリート', code:'DC-02', price:'¥12,000〜20,000', unit:'㎡', detail:'材料 ¥12,000〜／㎡ + 施工費 ¥8,000〜／㎡', life:'約20年', cases:'施工実績 3件'},
    {company:'四国化成', name:'リンクストーン', code:'LS-10', price:'¥9,800〜15,000', unit:'㎡', detail:'材料 ¥9,800〜／㎡ + 施工費 ¥6,000〜／㎡', life:'約20年', cases:'施工実績 2件'}
  ],
  marble: [
    {company:'LIXIL', name:'大理石調タイル マーブル', code:'IPF-600', price:'¥14,000〜22,000', unit:'㎡', detail:'本体 ¥14,000〜／㎡ + 施工費 ¥8,000〜／㎡', life:'約30年', cases:'施工実績 6件'},
    {company:'ADVAN', name:'天然大理石 クレママーフィル', code:'AD-03', price:'¥24,000〜40,000', unit:'㎡', detail:'本体 ¥24,000〜／㎡ + 施工費 ¥12,000〜／㎡', life:'約30年', cases:'施工実績 3件'},
    {company:'TOTO', name:'クオラス フロアタイル', code:'QRS-01', price:'¥10,000〜16,000', unit:'㎡', detail:'本体 ¥10,000〜／㎡ + 施工費 ¥7,000〜／㎡', life:'約20年', cases:'施工実績 4件'}
  ],
  tatami: [
    {company:'大建工業', name:'健やかおもて 清流', code:'YQ-01', price:'¥9,500〜14,000', unit:'㎡', detail:'表替え ¥9,500〜／枚 + 施工費込み', life:'約10年', cases:'施工実績 6件'},
    {company:'セキスイ畳', name:'MIGUSA 市松', code:'MG-02', price:'¥12,000〜18,000', unit:'㎡', detail:'表材 ¥12,000〜／枚 + 施工費込み', life:'約10年', cases:'施工実績 5件'},
    {company:'積水成型工業', name:'美草 アースカラー', code:'EA-03', price:'¥10,000〜15,000', unit:'㎡', detail:'表材 ¥10,000〜／枚 + 施工費込み', life:'約10年', cases:'施工実績 4件'}
  ]
};

function renderMaterialCandidates(key) {
  const candidates = MATERIAL_CANDIDATES[key] || MATERIAL_CANDIDATES.composite;
  return `<div class="material-candidates">
    <div class="material-candidates-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>おすすめ候補（${candidates.length}件）</div>
    <div class="material-candidates-note">素材の特徴と価格帯を比較できます。価格は材料費・施工費の目安です。</div>
    ${candidates.map((c, i) => `<div class="material-candidate">
      <div class="material-candidate-thumb">${i + 1}</div>
      <div class="material-candidate-body">
        <div class="material-candidate-company">${escapeHTML(c.company)}</div>
        <div class="material-candidate-name">${escapeHTML(c.name)}<span class="material-candidate-code">品番 ${escapeHTML(c.code)}</span></div>
        <div class="material-candidate-price">${escapeHTML(c.price)}<small>/ ${escapeHTML(c.unit)}</small></div>
        <div class="material-candidate-details"><span><b>価格内訳</b>${escapeHTML(c.detail)}</span><span><b>耐用年数</b>${escapeHTML(c.life)}</span><span><b>実績</b>${escapeHTML(c.cases)}</span></div>
      </div>
    </div>`).join('')}
    <div class="material-candidate-source">出典：各社カタログ・施工事例をもとにした参考価格（現地条件・地域により変動します）</div>
  </div>`;
}

async function requestMaterialRecommendation(key, materialMsg) {
  const result = materialMsg.querySelector('[data-material-ai]');
  if (!result) return;
  const fallbackText = '\u767b\u9332\u6e08\u307f\u306e\u6a19\u6e96\u5019\u88dc\u3092\u8868\u793a\u3057\u3066\u3044\u307e\u3059\u3002';
  if (!EDGE_URL) {
    result.innerHTML = `<div style="color:#a05a30;">AI\u672a\u63a5\u7d9a\u306e\u305f\u3081\u3001${fallbackText}</div>`;
    return;
  }
  result.innerHTML = '<span style="color:var(--muted);">AI\u304c\u76f8\u8ac7\u5185\u5bb9\u3092\u78ba\u8a8d\u4e2d\u2026</span>';
  const catalog = Object.entries(MATERIALS).map(([materialKey, material]) => ({
    key: materialKey,
    name: material.name,
    category: material.category,
    pros: material.pros,
    cons: material.cons,
  }));
  try {
    const res = await fetchWithTimeout(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sessionToken,
        type: 'material_recommendation',
        selected_key: key,
        catalog,
        context: history.slice(-10),
      }),
    }, 20000);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.recommendations) || !data.recommendations.length) {
      throw new Error(data.error || 'material recommendation failed');
    }
    const recommendations = data.recommendations
      .map(item => ({ material: MATERIALS[item.key], reason: item.reason }))
      .filter(item => item.material && item.reason);
    if (!recommendations.length) throw new Error('invalid material recommendation');
    const heading = data.source === 'ai' ? '\u76f8\u8ac7\u5185\u5bb9\u304b\u3089\u306eAI\u7d20\u6750\u63d0\u6848' : '\u7d20\u6750\u63d0\u6848\uff08\u81ea\u52d5\u30d5\u30a9\u30fc\u30eb\u30d0\u30c3\u30af\uff09';
    const warning = data.source === 'ai' ? '' : `<div style="color:#a05a30;margin-bottom:5px;">${escapeHTML(data.warning || fallbackText)}</div>`;
    result.innerHTML = `<div style="font-weight:600;margin-bottom:5px;">${heading}</div>${warning}${recommendations.map(item => `<div style="margin-top:4px;"><b>${escapeHTML(item.material.name)}</b>：${escapeHTML(item.reason)}</div>`).join('')}`;
  } catch (e) {
    console.warn('Material recommendation API failed:', e.message);
    result.innerHTML = `<div style="color:#a05a30;">AI\u304b\u3089\u6b63\u3057\u3044\u56de\u7b54\u3092\u53d6\u5f97\u3067\u304d\u306a\u304b\u3063\u305f\u305f\u3081\u3001${fallbackText}</div>`;
  }
}

function stars(n, max=5) {
  return Array.from({length:max}, (_,i) =>
    `<div class="mat-star ${i<n?'on':'off'}"></div>`
  ).join('');
}

function showMaterial(key) {
  const m = MATERIALS[key];
    if (!m) { addAgentMessage('素材情報が見つかりませんでした。', null, null, ['素材を探す', '概算を見る', '担当者に相談']); return; }
  window._selectedMaterialKey = key;
  persistChatState('material');

  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent';

  div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      <div class="mat-card">
        <div class="mat-header" style="background:${m.bg}">
          <div class="mat-icon" style="background:${m.bg}">${m.icon}</div>
          <div>
            <div class="mat-name">${m.name}</div>
            <div class="mat-category">${m.category}</div>
          </div>
        </div>
        <div class="mat-ratings">
          <div class="mat-rating">
            <div class="mat-rating-label">耐久性</div>
            <div class="mat-stars">${stars(m.durability)}</div>
          </div>
          <div class="mat-rating">
            <div class="mat-rating-label">お手入れのしやすさ</div>
            <div class="mat-stars">${stars(m.maintenance)}</div>
          </div>
          <div class="mat-rating" style="border-top:1px solid #1a1a1a">
            <div class="mat-rating-label">耐水性</div>
            <div class="mat-stars">${stars(m.water)}</div>
          </div>
          <div class="mat-rating" style="border-top:1px solid #1a1a1a;border-right:none">
            <div class="mat-rating-label">水まわり適性</div>
            <div style="font-size:12px;color:#888;margin-top:3px;">${m.water_label}</div>
          </div>
        </div>
        <div class="mat-body">
          <div class="mat-row">
            <div class="mat-row-label">メリット</div>
            <div class="mat-pros">
              ${m.pros.map(p=>`<div class="mat-pro"><span>✓</span>${p}</div>`).join('')}
            </div>
          </div>
          <div class="mat-row">
            <div class="mat-row-label">注意点</div>
            <div class="mat-pros">
              ${m.cons.map(c=>`<div class="mat-con"><span>!</span>${c}</div>`).join('')}
            </div>
          </div>
          <div class="mat-meta">
            <div class="mat-badge">費用目安 <span>${m.cost}</span></div>
            <div class="mat-badge">耐用年数 <span>${m.life}</span></div>
          </div>
        </div>
      </div>
      ${renderMaterialCandidates(key)}
      <div data-material-ai style="margin-top:10px;padding:9px 10px;border-radius:7px;background:var(--bg);font-size:11px;line-height:1.6;"></div>
    </div>`;
  chat.appendChild(div);
  requestMaterialRecommendation(key, div);
  renderSuggestions(['画像で確認する', '概算を見る', '別の素材を見る', '担当者に相談', '提案書を作成']);
  scrollBottom();
}

// ── Day / Night Preview ──
async function generateNight(btn, afterSrc, beforeSrc) {
  // チップから起動した場合はボタン要素がないため、UI制御用の代替オブジェクトを使う
  const trigger = btn || { disabled: false, style: {} };
  trigger.disabled = true;
  trigger.style.opacity = '0.4';

  // Show loading card
  const chat = document.getElementById('chat');
  const card = document.createElement('div');
  card.className = 'msg agent'; card.id = 'dn-card';
  card.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      夜のイメージを生成中です...
      <div class="dn-generating">
        <div class="spinner" style="width:20px;height:20px;border-width:1.5px;"></div>
        夜の照明で再生成しています
      </div>
    </div>`;
  chat.appendChild(card); scrollBottom();

  try {
    // afterSrcがdata URIの場合はそのままblobに変換、URLの場合はfetch
    let blob0;
    if (afterSrc.startsWith('data:')) {
      const byteStr = atob(afterSrc.split(',')[1]);
      const arr = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
      blob0 = new Blob([arr], { type: 'image/png' });
    } else {
      const res0 = await fetch(afterSrc);
      blob0 = await res0.blob();
    }
    const file  = new File([blob0], 'after.png', { type: 'image/png' });

    const nightPrompt = 'Same interior at night. Warm indoor lighting from lamps and ceiling lights, dark evening outside the windows, cozy ambiance. Keep all furniture, materials, colors, and layout exactly the same. Photorealistic.';

    const form = new FormData();
    form.append('token', sessionToken);
    form.append('prompt', nightPrompt);
    form.append('image', file, 'after.png');

    const res  = await fetchWithTimeout(EDGE_URL, { method:'POST', headers: EDGE_HEADERS, body: form }, 90000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || JSON.stringify(data));

    const img = data.data?.[0];
    const nightSrc = img?.url || (img?.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
    if (!nightSrc) throw new Error('画像取得失敗: ' + JSON.stringify(data));

    document.getElementById('dn-card')?.remove();
    showDayNight(afterSrc, nightSrc);

  } catch(e) {
    document.getElementById('dn-card')?.remove();
    addAgentMessage(e.isTimeout
      ? '夜間イメージの生成に時間がかかりすぎたため中断しました。少し時間をおいてもう一度お試しください。'
      : '現在夜間イメージ生成をご利用いただけません。昼のイメージや別の相談へ進めます。', null, null,
      ['概算を見る', '担当者に相談', '相談内容を続ける']);
  } finally {
    trigger.disabled = false;
    trigger.style.opacity = '';
  }
}

function showDayNight(daySrc, nightSrc) {
  const safeDaySrc = safeImageSrc(daySrc);
  const safeNightSrc = safeImageSrc(nightSrc);
  if (!safeDaySrc || !safeNightSrc) {
    addAgentMessage('昼夜イメージの画像を表示できませんでした。別の方法で相談を続けられます。', null, null,
      ['概算を見る', '担当者に相談', '相談内容を続ける']);
    return;
  }
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'daynight-msg';

  div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      昼と夜のイメージを生成しました！照明の雰囲気の違いをご確認ください。
      <div class="daynight-wrap">
        <div class="daynight-tabs">
          <button class="dn-tab active" id="dn-day-tab" onclick="switchDN('day','${escapeHTML(escapeJSString(safeDaySrc))}','${escapeHTML(escapeJSString(safeNightSrc))}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            昼間
          </button>
          <button class="dn-tab" id="dn-night-tab" onclick="switchDN('night','${escapeHTML(escapeJSString(safeDaySrc))}','${escapeHTML(escapeJSString(safeNightSrc))}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            夜間
          </button>
        </div>
        <div class="dn-img-wrap">
          <img id="dn-img" src="${escapeHTML(safeDaySrc)}" alt="day/night">
          <span class="dn-label" id="dn-label" style="color:#c8a06e;">☀ 昼間</span>
        </div>
        <div class="share-bar" style="margin-top:8px;">
          <button class="share-btn line" onclick="shareNative(document.getElementById('dn-img').src)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            共有
          </button>
          <a class="share-btn dl" id="dn-dl" href="${escapeHTML(safeDaySrc)}" download="reno-daynight.png">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            保存
          </a>
        </div>
      </div>
    </div>`;
  chat.appendChild(div);
  scrollBottom();
  renderSuggestions(['別の箇所も試す', '概算を見る', '担当者に相談', '提案書を作成']);
}

function switchDN(mode, daySrc, nightSrc) {
  const img   = document.getElementById('dn-img');
  const label = document.getElementById('dn-label');
  const dl    = document.getElementById('dn-dl');
  const dayTab   = document.getElementById('dn-day-tab');
  const nightTab = document.getElementById('dn-night-tab');
  if (mode === 'day') {
    img.src = daySrc; dl.href = daySrc;
    label.textContent = '☀ 昼間'; label.style.color = '#c8a06e';
    dayTab.classList.add('active'); nightTab.classList.remove('active');
  } else {
    img.src = nightSrc; dl.href = nightSrc;
    label.textContent = '🌙 夜間'; label.style.color = '#8090c0';
    nightTab.classList.add('active'); dayTab.classList.remove('active');
  }
}

function getMockConversationSummary(messages) {
  const text = messages.filter(message => message.role === 'user').map(message => String(message.content || '')).join('、');
  const find = values => values.find(value => text.includes(value)) || '';
  return {
    room: find(['リビング', 'キッチン', '浴室', '洗面所', '寝室', '玄関', '和室']) || '未指定',
    parts: find(['床材', '壁紙', 'キッチン設備', '照明', '収納']) || '未指定',
    style: find(['モダン', 'ナチュラル', '和風', 'インダストリアル', '北欧風']) || '未指定',
    budget: find(['50万円以下', '50〜100万円', '100〜200万円', '200万円以上']) || '未指定',
    notes: text.slice(-160),
    summary: text ? `会話内容をもとにしたデモ要約です。${text.slice(-120)}` : '会話内容のデモ要約です。',
  };
}

async function fetchConversationSummary() {
  const summaryRes = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: sessionToken, type: 'chat',
      system: `会話履歴からリフォームの要望を抽出し、以下のJSON形式のみで返してください。前後の説明は不要です。
{"room":"部屋名","parts":"変更箇所","style":"希望スタイル","budget":"予算","notes":"その他の要望・メモ","summary":"2〜3文の要望まとめ"}`,
      messages: [...history, { role: 'user', content: 'この会話の要望をJSONにまとめてください' }]
    })
  });
  const summaryData = await summaryRes.json();
  const raw = summaryData.content?.[0]?.text || '{}';
  try {
    const match = raw.match(/\{[\s\S]+\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch (e) {
    return {};
  }
}

// ── PDF Generation ──
// PDF用の会話要約。ローカルAPIの応答形式に依存せず、確定した会話内容を反映する。
function getPdfConversationSummary(messages) {
  const userText = messages
    .filter(message => message.role === 'user')
    .map(message => String(message.content || '').trim())
    .filter(Boolean);
  const text = userText.join(' / ');
  const find = values => values.find(value => text.includes(value)) || '';
  const budgetMatch = text.match(/(?:予算|費用|金額)[^。\n]{0,12}(50万円以下|50(?:〜|～|-|~)100万円|100(?:〜|～|-|~)200万円|200万円以上)/)
    || text.match(/(50万円以下|50(?:〜|～|-|~)100万円|100(?:〜|～|-|~)200万円|200万円以上)/);
  const room = find(['リビング', 'キッチン', '洗面所', '洗面室', '浴室', 'バスルーム', '玄関', '寝室', '和室', 'トイレ']);
  const style = find(['モダン', 'ナチュラル', '北欧', 'インダストリアル', '和風', 'シンプル']);
  const parts = find(['壁', '床', '収納', '照明', 'キッチン', '浴室', '洗面', '間取り']);
  return {
    room: room || '未指定',
    parts: parts || '未指定',
    style: style || '未指定',
    budget: budgetMatch?.[1] || '未指定',
    notes: text || '会話メモなし',
    summary: text ? `会話で確認したご要望：${text}` : '会話内容の要約はありません。'
  };
}

async function generatePDF(afterSrc, beforeSrc, onComplete = null) {
  const overlay = document.getElementById('pdfOverlay');
  overlay.style.display = 'flex';

  try {
    // 1. 会話の要約（チャットモック時はローカルで作成）
    const info = getPdfConversationSummary(history);
    // 会話で予算を明言していなくても、概算シミュレーターの結果を予算欄へ反映する。
    if (simState.items.size) {
      const estimate = calcCost();
      info.budget = `${fmtMoney(estimate.lo)}〜${fmtMoney(estimate.hi)}`;
      info.summary += ` 概算結果：${info.budget}`;
    }
    const selectedMaterial = MATERIALS[window._selectedMaterialKey];
    if (selectedMaterial && info.parts === '未指定') {
      info.parts = selectedMaterial.name;
    }

    // 2. Fill PDF template
    const tmpl = document.getElementById('pdfTemplate');
    tmpl.style.display = 'block';

    // Date
    document.getElementById('pdf-date').textContent =
      new Date().toLocaleDateString('ja-JP', { year:'numeric', month:'long', day:'numeric' });

    // Info table
    const fields = [
      ['対象エリア', info.room || '—'],
      ['施工箇所',   info.parts || '—'],
      ['ご希望スタイル', info.style || '—'],
      ['ご予算',     info.budget || '—'],
    ];
    const table = document.getElementById('pdf-info-table');
    table.innerHTML = fields.map(([label, val]) => `
      <tr style="border-bottom:1px solid #1e1e1e;">
        <td style="padding:9px 0;color:#686868;font-size:10px;letter-spacing:0.1em;width:120px;">${escapeHTML(label)}</td>
        <td style="padding:9px 0;color:#c8a96e;font-size:12px;font-weight:500;">${escapeHTML(val)}</td>
      </tr>`).join('');

    // Summary
    if (info.summary) {
      document.getElementById('pdf-summary-text').textContent = info.summary;
      document.getElementById('pdf-summary-block').style.display = 'block';
    } else {
      document.getElementById('pdf-summary-block').style.display = 'none';
    }

    // Images
    const toBase64 = async (src) => {
      if (!src) return '';
      if (src.startsWith('data:')) return src;
      const res = await fetch(src);
      const blob = await res.blob();
      return new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(blob); });
    };
    const [afterB64, beforeB64] = await Promise.all([toBase64(afterSrc), toBase64(beforeSrc)]);
    const beforeImage = document.getElementById('pdf-before-img');
    const afterImage = document.getElementById('pdf-after-img');
    beforeImage.parentElement.style.display = beforeB64 ? 'block' : 'none';
    afterImage.parentElement.style.display = afterB64 ? 'block' : 'none';
    beforeImage.src = beforeB64;
    afterImage.src = afterB64;
    document.getElementById('pdf-images-block').style.display = beforeB64 || afterB64 ? 'block' : 'none';

    // Notes
    if (info.notes) {
      document.getElementById('pdf-notes-text').textContent = info.notes;
      document.getElementById('pdf-notes-block').style.display = 'block';
    } else {
      document.getElementById('pdf-notes-block').style.display = 'none';
    }

    // 3. Wait for images to load
    await new Promise(r => setTimeout(r, 600));

    // 4. html2canvas → jsPDF
    const canvas = await html2canvas(tmpl.firstElementChild, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#0c0c0c',
      width: 794,
      windowWidth: 794
    });

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, H = 297;
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const canvasH = (canvas.height / canvas.width) * W;
    // テンプレートの丸め誤差でA4を1pxだけ超える場合、空の2ページ目を作らない。
    if (canvasH <= H + 1) {
      doc.addImage(imgData, 'JPEG', 0, 0, W, Math.min(canvasH, H));
    } else {
      // Multi-page
      let srcY = 0;
      const pageH = (H / W) * canvas.width;
      while (srcY < canvas.height) {
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = Math.min(pageH, canvas.height - srcY);
        pageCanvas.getContext('2d').drawImage(canvas, 0, -srcY);
        doc.addImage(pageCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, W, H);
        srcY += pageH;
        if (srcY < canvas.height) doc.addPage();
      }
    }

    doc.save(`RENO-ai-提案書-${Date.now()}.pdf`);
    if (typeof onComplete === 'function') onComplete();

  } catch(e) {
    addAgentMessage('現在提案書の生成をご利用いただけません。相談内容を残したまま、別の方法で進められます。', null, null,
      ['施工後イメージ', '概算を見る', '相談内容を続ける']);
    finalizationState = 'draft';
  } finally {
    overlay.style.display = 'none';
    const tmpl = document.getElementById('pdfTemplate');
    if (tmpl) tmpl.style.display = 'none';
  }
}

// ── Cost Simulator ──
const COST_DATA = {
  sizes: [
    { label:'〜6畳', m2: 10 },
    { label:'8畳',   m2: 13 },
    { label:'10畳',  m2: 16 },
    { label:'12畳〜',m2: 20 },
  ],
  items: [
    { key:'floor',   label:'床材',       base:[8,15],   unit:'m2' },
    { key:'wall',    label:'壁紙',       base:[1,2.5],  unit:'m2' },
    { key:'kitchen', label:'キッチン',   base:[60,180], unit:'flat' },
    { key:'bath',    label:'浴室',       base:[60,150], unit:'flat' },
    { key:'toilet',  label:'トイレ',     base:[15,50],  unit:'flat' },
    { key:'wash',    label:'洗面所',     base:[15,50],  unit:'flat' },
    { key:'light',   label:'照明',       base:[8,30],   unit:'flat' },
    { key:'storage', label:'収納',       base:[15,60],  unit:'flat' },
  ],
  grades: [
    { key:'eco',   label:'エコノミー', mult:0.75 },
    { key:'std',   label:'スタンダード', mult:1.0 },
    { key:'pre',   label:'プレミアム',   mult:1.5 },
  ],
};

let simState = { sizeIdx:1, items:new Set(['floor','wall']), gradeIdx:1 };
const DEFAULT_SIM_ITEMS = ['floor', 'wall'];

function calcCost() {
  const m2 = COST_DATA.sizes[simState.sizeIdx].m2;
  const mult = COST_DATA.grades[simState.gradeIdx].mult;
  let lo = 0, hi = 0;
  COST_DATA.items.forEach(item => {
    if (!simState.items.has(item.key)) return;
    // base は万円単位で管理しているため、㎡単価も円へ換算してから合算する。
    if (item.unit === 'm2') { lo += item.base[0] * m2 * 10000; hi += item.base[1] * m2 * 10000; }
    else                    { lo += item.base[0] * 10000; hi += item.base[1] * 10000; }
  });
  lo = Math.round(lo * mult / 10000) * 10000;
  hi = Math.round(hi * mult / 10000) * 10000;
  return { lo, hi };
}

function fmtMoney(n) {
  if (n >= 1000000) return (n/10000).toFixed(0) + '万円';
  return (n/10000).toFixed(0) + '万円';
}

function updateSimResult() {
  const { lo, hi } = calcCost();
  const el = document.getElementById('sim-price');
  if (!el) return;
  if (lo === 0) { el.textContent = '項目を選択してください'; return; }
  el.textContent = `${fmtMoney(lo)} 〜 ${fmtMoney(hi)}`;
}

function getEstimateCacheKey() {
  return `reno_estimate_v1:${JSON.stringify({
    size: [6, 8, 10, 12][simState.sizeIdx],
    items: [...simState.items].sort(),
    grade: ['eco', 'std', 'pre'][simState.gradeIdx],
  })}`;
}

function readEstimateCache(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && value.expiresAt > Date.now() ? value.data : null;
  } catch (e) { return null; }
}

function writeEstimateCache(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ expiresAt: Date.now() + 30 * 60 * 1000, data })); } catch (e) {}
}

function applyEstimateResult(card, data) {
  window._lastEstimate = data;
  const price = card.querySelector('.sim-result-price');
  const duration = card.querySelector('.sim-duration-value');
  const note = card.querySelector('.sim-result-note');
  if (price) price.textContent = `${fmtMoney(data.estimate.low)} 〜 ${fmtMoney(data.estimate.high)}`;
  if (duration) duration.textContent = `${data.duration.low}〜${data.duration.high}週間`;
  if (note) note.textContent = [data.explanation, data.warning].filter(Boolean).join(' ');
  const subsidyValue = card.querySelector('.sim-result-subinfo-value');
  if (subsidyValue) {
    subsidyValue.textContent = data.subsidies?.length
      ? data.subsidies.map(program => program.name).join('、')
      : '該当候補なし（追加条件を確認）';
    subsidyValue.title = data.subsidies?.map(program => `${program.name}：${program.source_url}`).join('\n') || '';
  }
}

async function requestEstimate() {
  const card = document.getElementById('sim-msg');
  if (!card) return;
  const durationEl = card.querySelector('.sim-duration-value');
  const priceEl = card.querySelector('.sim-result-price');
  const noteEl = card.querySelector('.sim-result-note');
  if (!simState.items.size) return;
  const cacheKey = getEstimateCacheKey();
  const cached = readEstimateCache(cacheKey);
  if (cached) {
    applyEstimateResult(card, cached);
    return;
  }
  if (!EDGE_URL) {
    if (priceEl) priceEl.textContent = 'API未接続';
    if (durationEl) durationEl.textContent = '—';
    if (noteEl) noteEl.textContent = '見積りAPIに接続できないため、算出できません。';
    return;
  }
  if (durationEl) durationEl.textContent = '計算中…';
  if (priceEl) priceEl.textContent = '計算中…';
  try {
    const res = await fetchWithTimeout(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sessionToken,
        type: 'estimate',
        size: String([6, 8, 10, 12][simState.sizeIdx]),
        items: [...simState.items],
        grade: ['eco', 'std', 'pre'][simState.gradeIdx],
        context: history.slice(-10),
      }),
    }, 20000);
    const data = await res.json();
    if (!res.ok || !data.estimate || !data.duration) throw new Error(data.error || 'estimate failed');
    applyEstimateResult(card, data);
    writeEstimateCache(cacheKey, data);
  } catch (e) {
    console.warn('Estimate API failed:', e.message);
    if (durationEl) durationEl.textContent = '現地調査後に確定';
    const note = card.querySelector('.sim-result-note');
    if (note) note.textContent = '概算APIに接続できないため、現地調査後に正式な工期を確定します。';
  }
}

function getEstimateDurationLabel() {
  const duration = window._lastEstimate?.duration;
  return duration ? `${duration.low}〜${duration.high}週間` : '2〜3週間';
}

function showSimulator() {
  setTimeout(requestEstimate, 0);
  const chat = document.getElementById('chat');
  persistChatState('simulator');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'sim-msg';

  const sizeBtns = COST_DATA.sizes.map((s,i) =>
    `<button class="sim-sz ${i===simState.sizeIdx?'active':''}" onclick="simSetSize(${i})">${s.label}</button>`
  ).join('');

  const itemBtns = COST_DATA.items.map(item =>
    `<div class="sim-item ${simState.items.has(item.key)?'active':''}" onclick="simToggleItem('${item.key}')">
      <div class="sim-check">
        ${simState.items.has(item.key)?'<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#0c0c0c" stroke-width="2.5" stroke-linecap="round"><polyline points="2,6 5,9 10,3"/></svg>':''}
      </div>
      <span class="sim-item-label">${item.label}</span>
    </div>`
  ).join('');

  const gradeBtns = COST_DATA.grades.map((g,i) =>
    `<button class="sim-grade ${i===simState.gradeIdx?'active':''}" onclick="simSetGrade(${i})">${g.label}</button>`
  ).join('');

  div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      <div class="sim-card">
        <div class="sim-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          工事費 概算シミュレーター
        </div>
        <div class="sim-section">
          <div class="sim-label">お部屋の広さ</div>
          <div class="sim-sizes">${sizeBtns}</div>
        </div>
        <div class="sim-section">
          <div class="sim-label">施工箇所（複数選択可）</div>
          <div class="sim-items">${itemBtns}</div>
        </div>
        <div class="sim-section">
          <div class="sim-label">グレード</div>
          <div class="sim-grades">${gradeBtns}</div>
        </div>
          <div class="sim-result">
            <div class="sim-result-label">今回の概算</div>
            <div class="sim-result-highlights">
              <div class="sim-metric">
                <div class="sim-metric-label">概算費用</div>
                <div class="sim-result-price" id="sim-price">${simState.items.size ? '算出中…' : '項目を選択してください'}</div>
              </div>
              <div class="sim-metric duration">
                <div class="sim-metric-label">概算工期</div>
                <div class="sim-duration-value">${getEstimateDurationLabel()}</div>
              </div>
            </div>
            <div class="sim-result-note">※ 相場の目安です。実際の費用は現地調査にてご確認ください。</div>
            <div class="sim-result-subinfo">
              <div><div class="sim-result-subinfo-label">補助金候補</div><div class="sim-result-subinfo-value">要件を確認</div></div>
              <div><div class="sim-result-subinfo-label">確認方法</div><div class="sim-result-subinfo-value">現地調査</div></div>
            </div>
            <div class="sim-result-footnote">候補：住宅リフォーム補助制度、断熱改修支援など。地域・工事内容により対象が変わります。</div>
          </div>
        <button class="sim-confirm" onclick="simConfirm()" ${simState.items.size ? '' : 'disabled'}>この内容を確認する</button>
        <button class="sim-reset" type="button" onclick="simResetChoices()">条件を選び直す</button>
      </div>
    </div>`;
  chat.appendChild(div);
  scrollBottom();
}

function simSetSize(i) {
  simState.sizeIdx = i;
  persistChatState('simulator');
  refreshSim();
}
function simToggleItem(key) {
  if (simState.items.has(key)) simState.items.delete(key);
  else simState.items.add(key);
  persistChatState('simulator');
  refreshSim();
}
function simSetGrade(i) {
  simState.gradeIdx = i;
  persistChatState('simulator');
  refreshSim();
}
function refreshSim() {
  const old = document.getElementById('sim-msg');
  if (!old) return;
  old.remove();
  showSimulator();
}
function simResetChoices() {
  simState = { sizeIdx: 1, items: new Set(DEFAULT_SIM_ITEMS), gradeIdx: 1 };
  persistChatState('simulator');
  refreshSim();
}
let finalizationState = 'draft';
let finalHandoffStarted = false;

function showFinalConfirmation() {
  document.getElementById('final-confirm-msg')?.remove();
  const rows = getHandoffSummary('最終確認');
  const hasPdf = true;
  const estimate = simState.items.size ? calcCost() : null;
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.id = 'final-confirm-msg';
  div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent">
      <div class="handoff-card">
        <div class="handoff-title">相談内容の最終確認</div>
        ${estimate ? `<div class="handoff-estimate">
          <div class="handoff-estimate-title">今回の概算</div>
          <div class="handoff-estimate-grid">
            <div class="handoff-estimate-metric">
              <div class="handoff-estimate-label">概算費用</div>
              <div class="handoff-estimate-value">${fmtMoney(estimate.lo)} 〜 ${fmtMoney(estimate.hi)}</div>
            </div>
            <div class="handoff-estimate-metric">
              <div class="handoff-estimate-label">概算工期</div>
              <div class="handoff-estimate-value duration">${getEstimateDurationLabel()}</div>
            </div>
          </div>
        </div>` : ''}
        <div class="handoff-lead">内容を確定すると、提案書PDFを保存した後に担当者への相談受付へ進みます。</div>
        <div class="handoff-summary">
          <div class="handoff-summary-title">確定する内容</div>
          ${rows.map(row => `<div class="handoff-summary-row">・${escapeHTML(row)}</div>`).join('')}
        </div>
        <button id="final-confirm-submit" class="handoff-submit" type="button" onclick="window.completeFinalConsultation()">${hasPdf ? '内容を確定してPDFを保存' : '内容を確定して相談受付へ進む'}</button>
        <button class="sim-reset" type="button" onclick="reselectEstimate()">概算条件を選び直す</button>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px;">
          <button class="sim-reset" type="button" style="margin-top:0;" onclick="returnToEarlierStep('material')">素材を探す</button>
          <button class="sim-reset" type="button" style="margin-top:0;" onclick="returnToEarlierStep('image')">施工後イメージ</button>
        </div>
        <button class="sim-reset" type="button" onclick="returnToEarlierStep('chat')">相談内容を続ける</button>
        <div class="handoff-note">※ 確定後の担当者相談は、この1回のみ表示されます。</div>
      </div>
    </div>`;
  document.getElementById('chat').appendChild(div);
  persistChatState('final-confirm');
  finalizationState = 'review';
  scrollBottom();
}

function completeFinalConsultation() {
  if (finalizationState !== 'review') {
    addAgentMessage('この確認画面はすでに処理済みです。概算画面からもう一度確認できます。', null, null, ['概算を見る']);
    return;
  }
  if (finalHandoffStarted) return;
  try {
    finalizationState = 'confirmed';
    const submit = document.getElementById('final-confirm-submit');
    if (submit) {
      submit.disabled = true;
      submit.textContent = window._lastAfterSrc && window._lastBeforeSrc ? 'PDFを保存しています…' : '受付フォームを準備しています…';
    }
    document.getElementById('final-confirm-msg')?.remove();
    addUserMessage('相談内容を確定しました');
    const after = window._lastAfterSrc;
    const before = window._lastBeforeSrc;
    if (true) {
      generatePDF(after, before, () => {
        clearDraftCache();
        handoffToStaff('最終確定済み');
      });
    } else {
      clearDraftCache();
      handoffToStaff('最終確定済み');
    }
  } catch (e) {
    finalizationState = 'review';
    addAgentMessage('確定処理を開始できませんでした。もう一度お試しください。', null, null, ['概算を見る']);
  }
}
window.completeFinalConsultation = completeFinalConsultation;

function reselectEstimate() {
  if (finalizationState === 'confirmed' || finalHandoffStarted) return;
  finalizationState = 'draft';
  document.getElementById('final-confirm-msg')?.remove();
  showSimulator();
}

function returnToEarlierStep(step) {
  if (finalizationState === 'confirmed' || finalHandoffStarted) return;
  finalizationState = 'draft';
  document.getElementById('final-confirm-msg')?.remove();
  if (step === 'material') {
    addUserMessage('素材を探す');
    showMaterial('composite');
  } else if (step === 'image') {
    addUserMessage('施工後イメージ');
    if (window._beforeFile || window._beforeURL) {
      generateWithFiles(window._beforeFile, null);
    } else {
      showUploadCard('施工後イメージを作成するため、現状写真を選んでください');
    }
  } else {
    addAgentMessage('このまま相談を続けられます。確認したいことを入力してください。');
    document.getElementById('userInput')?.focus();
  }
}

function simConfirm() {
  if (simState.items.size === 0) {
    addAgentMessage('施工箇所を1つ以上選択してください。');
    return;
  }
  document.getElementById('sim-msg')?.remove();
  persistChatState('final-confirm');
  showFinalConfirmation();
}

// ── Usage ──
let currentUsage = { plan:'free', count:0, limit:100, remaining:100 };
const DEMO_BYPASS_LIMIT = false; // ユーザー管理導入により実際のプラン/残り回数を表示

async function fetchUsage() {
  try {
    const res  = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_usage' })
    });
    const data = await res.json();
    if (!res.ok || !Number.isFinite(Number(data?.count)) || !Number.isFinite(Number(data?.limit))) {
      if (res.status === 401) {
        clearAuthSession();
        if (sessionRole === 'guest') {
          sessionToken = '';
          await startDemoSession();
          return;
        }
      }
      const el = document.getElementById('usageBadge');
      if (el) el.textContent = '利用回数を確認できません';
      return;
    }
    currentUsage = data;
    renderUsageBadge();
  } catch(e) {}
}

function renderUsageBadge() {
  const el = document.getElementById('usageBadge');
  if (!el) return;
  if (DEMO_BYPASS_LIMIT) {
    el.innerHTML = '<span style="color:var(--gold);font-size:11px;">✦ Demo</span>';
    return;
  }
  const { plan, count, limit } = currentUsage;
  if (currentUsage.unlimited || plan === 'unlimited') {
    el.innerHTML = '<span style="color:var(--gold);font-size:11px;">∞ 無制限</span>';
    return;
  }
  if (plan === 'pro') { el.innerHTML = '<span style="color:#7ab87a;font-size:11px;">✦ Pro</span>'; return; }
  const pips = Array.from({ length: limit > 10 ? 10 : limit }, (_, i) => {
    const used = i < count;
    const warn = used && count >= limit;
    return `<div class="usage-pip ${used ? (warn ? 'warn' : 'used') : ''}"></div>`;
  }).join('');
  const label = plan === 'standard'
    ? `${count}/${limit}`
    : `残り${limit - count}回`;
  el.innerHTML = `${pips}<span style="margin-left:3px;">${label}</span>`;
}

function updateUsageAfterGen(usageData) {
  if (!usageData || !Number.isFinite(Number(usageData.count)) || !Number.isFinite(Number(usageData.limit))) return;
  currentUsage = usageData;
  renderUsageBadge();
}

function showUpgradeModal() {
  document.getElementById('upgradeModal').classList.add('open');
}
function closeUpgradeModal() {
  document.getElementById('upgradeModal').classList.remove('open');
}

const SAMPLE_IMAGES = [
  { label: 'リビング',  src: 'assets/samples/living.jpg' },
  { label: '和室',      src: 'assets/samples/washitsu.jpg' },
  { label: '子供部屋',  src: 'assets/samples/bedroom.jpg' },
  { label: 'キッチン',  src: 'assets/samples/kitchen.jpg' },
  { label: '洗面所',    src: 'assets/samples/washroom.jpg' },
  { label: '浴室',      src: 'assets/samples/bathroom.jpg' },
  { label: '玄関',      src: 'assets/samples/entrance.jpg' },
];

// ── Guest PIN Panel ──
let gpinDays = 7;
let gpinUses = 30;

function openGuestPinPanel() {
  document.getElementById('guestPinPanel').classList.add('open');
  renderGpinPanel();
}
function closeGuestPinPanel() {
  document.getElementById('guestPinPanel').classList.remove('open');
}
function closeGuestPinOuter(e) {
  if (e.target === document.getElementById('guestPinPanel')) closeGuestPinPanel();
}

function renderGpinPanel() {
  document.getElementById('gpinBody').innerHTML = `
    <div class="gpin-form">
      <div class="gpin-form-title">新しいPINを発行</div>
      <div class="gpin-row">
        <label class="gpin-label">施主のお名前（メモ用）</label>
        <input type="text" id="gpinLabel" class="gpin-input" placeholder="例：山田様">
      </div>
      <div class="gpin-row">
        <label class="gpin-label">有効期限</label>
        <div class="gpin-days">
          ${[3,7,14].map(d => `<button class="gpin-day ${gpinDays===d?'active':''}" onclick="gpinSetDays(${d})">${d}日間</button>`).join('')}
        </div>
      </div>
      <div class="gpin-row">
        <label class="gpin-label">使用回数</label>
        <div class="gpin-uses">
          ${[10,30,99].map(u => `<button class="gpin-use ${gpinUses===u?'active':''}" onclick="gpinSetUses(${u})">${u}回</button>`).join('')}
        </div>
      </div>
      <button class="gpin-issue-btn" id="gpinIssueBtn" onclick="issueGuestPin()">PINを発行する</button>
    </div>
    <div id="gpinResult"></div>
    <div id="gpinList"></div>`;
  loadGuestPins();
}

function gpinSetDays(d) { gpinDays = d; renderGpinPanel(); }
function gpinSetUses(u) { gpinUses = u; renderGpinPanel(); }

async function issueGuestPin() {
  const label = document.getElementById('gpinLabel').value.trim() || '施主様';
  const btn = document.getElementById('gpinIssueBtn');
  btn.disabled = true; btn.textContent = '発行中...';
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'create_guest_pin', label, days: gpinDays, max_uses: gpinUses })
    });
    const data = await res.json();
    if (data.pin) showGpinResult(data);
    else throw new Error(data.error || '発行失敗');
  } catch(e) {
    alert('エラー: ' + e.message);
    btn.disabled = false; btn.textContent = 'PINを発行する';
  }
}

function showGpinResult(data) {
  const expires = new Date(data.expires_at).toLocaleDateString('ja-JP', { month:'long', day:'numeric' });
  const url = `${location.origin}${location.pathname}`;
  const fullUrl = `${url}?pin=${data.pin}`;
  const encodedLabel = encodeURIComponent(String(data.label || '施主様'));
  document.getElementById('gpinResult').innerHTML = `
    <div class="gpin-result">
      <div class="gpin-result-label">✦ 発行完了</div>
      <div class="gpin-result-pin">${escapeHTML(data.pin)}</div>
      <div class="gpin-result-meta">
        ${escapeHTML(data.label || '施主様')}・${gpinDays}日間有効（${escapeHTML(expires)}まで）<br>
        使用回数：${escapeHTML(data.max_uses)}回まで
      </div>
      <div id="gpinQrWrap" style="margin:0 auto 12px;width:160px;height:160px;background:var(--bg2);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;">QR生成中...</div>
      <div style="display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--muted);word-break:break-all;background:var(--bg2);border-radius:6px;padding:8px 10px;margin-bottom:12px;">
        <span style="flex:1;">${fullUrl}</span>
        <button onclick="copyGpinUrl('${fullUrl}')" title="URLをコピー" style="flex-shrink:0;width:26px;height:26px;border-radius:6px;border:1px solid var(--border);background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <div class="gpin-result-btns">
        <button class="gpin-copy-btn" onclick="copyGpinInfo('${data.pin}','${url}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:middle;margin-right:5px;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>PINをコピー
        </button>
        <button class="gpin-copy-btn gpin-share-btn" onclick="shareGpin('${data.pin}','${url}',decodeURIComponent('${encodedLabel}'))">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:middle;margin-right:5px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>共有
        </button>
      </div>
    </div>`;
  generateQR(data.pin, url);
  loadGuestPins();
}

function copyGpinUrl(fullUrl) {
  navigator.clipboard.writeText(fullUrl).then(() => alert('URLをコピーしました！'));
}

async function generateQR(pin, baseUrl) {
  // QR code using API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(baseUrl + '?pin=' + pin)}`;
  const wrap = document.getElementById('gpinQrWrap');
  if (!wrap) return;
  wrap.innerHTML = `<img src="${qrUrl}" width="160" height="160" style="border-radius:6px;display:block;" alt="QR">`;
}

function copyGpinInfo(pin, url) {
  const text = `RENO リフォームシミュレーター\nPIN: ${pin}\n${url}`;
  navigator.clipboard.writeText(text).then(() => alert('コピーしました！'));
}

async function shareGpin(pin, url, label) {
  const text = `【RENO】${label}様\nリフォームのイメージを確認できます。\n\nPIN番号: ${pin}\n${url}\n\n※有効期限・回数制限があります。`;
  if (navigator.share) {
    await navigator.share({ title: 'RENO', text });
  } else {
    navigator.clipboard.writeText(text).then(() => alert('テキストをコピーしました！'));
  }
}

async function loadGuestPins() {
  const listEl = document.getElementById('gpinList');
  if (!listEl) return;
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_guest_pins' })
    });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    const now = new Date();
    listEl.innerHTML = `
      <div style="font-size:10px;color:var(--muted);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px;">発行済みPIN一覧</div>
      ${data.map(g => {
        const expired = new Date(g.expires_at) < now || !g.is_active;
        const expires = new Date(g.expires_at).toLocaleDateString('ja-JP', { month:'short', day:'numeric' });
        const encodedId = encodeURIComponent(String(g.id || ''));
        return `<div class="gpin-list-item">
          <div class="gpin-list-pin">${escapeHTML(g.pin)}</div>
          <div class="gpin-list-info">
            <div class="gpin-list-label">${escapeHTML(g.label || '施主様')}</div>
            <div class="gpin-list-meta">${escapeHTML(expires)}まで・${escapeHTML(g.use_count)}/${escapeHTML(g.max_uses)}回使用</div>
            <span class="gpin-list-badge ${expired ? 'expired' : 'active'}">${expired ? '期限切れ' : '有効'}</span>
          </div>
          <button class="gpin-list-del" onclick="deleteGuestPin(decodeURIComponent('${encodedId}'))">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>`;
      }).join('')}`;
  } catch(e) {}
}

async function deleteGuestPin(id) {
  if (!confirm('このPINを削除しますか？')) return;
  await fetch(EDGE_URL, {
    method: 'POST',
    headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken, type: 'delete_guest_pin', id })
  });
  loadGuestPins();
}

// ── Menu Sheet ──
function openMenuSheet() {
  document.getElementById('menuSheet').classList.add('open');
}
function closeMenuSheet() {
  document.getElementById('menuSheet').classList.remove('open');
}
function closeMenuOuter(e) {
  if (e.target === document.getElementById('menuSheet')) closeMenuSheet();
}

// ── Cases Panel ──
let casesTab = 'upload';
let caseImgData = '';
let caseImgFile = null;

function openCasesPanel() {
  document.getElementById('casesPanel').classList.add('open');
  renderCasesTab();
}
function closeCasesPanel() {
  document.getElementById('casesPanel').classList.remove('open');
}
function closeCasesOuter(e) {
  if (e.target === document.getElementById('casesPanel')) closeCasesPanel();
}
function switchCasesTab(tab) {
  casesTab = tab;
  document.getElementById('tab-upload').classList.toggle('active', tab==='upload');
  document.getElementById('tab-list').classList.toggle('active', tab==='list');
  renderCasesTab();
}

function renderCasesTab() {
  if (casesTab === 'upload') renderUploadForm();
  else renderCasesList();
}

function renderUploadForm() {
  document.getElementById('casesBody').innerHTML = `
    <div class="case-form-field">
      <label class="case-form-label">タイトル</label>
      <input type="text" id="cf-title" class="case-form-input" placeholder="例：リビング フルリノベーション">
    </div>
    <div class="case-form-field">
      <label class="case-form-label">部屋</label>
      <input type="text" id="cf-room" class="case-form-input" placeholder="例：リビング、キッチン、浴室">
    </div>
    <div class="case-form-field">
      <label class="case-form-label">スタイル</label>
      <input type="text" id="cf-style" class="case-form-input" placeholder="例：モダン、ナチュラル、和風">
    </div>
    <div class="case-form-field">
      <label class="case-form-label">予算帯</label>
      <input type="text" id="cf-budget" class="case-form-input" placeholder="例：100〜150万円">
    </div>
    <div class="case-form-field">
      <label class="case-form-label">施工のポイント</label>
      <input type="text" id="cf-desc" class="case-form-input" placeholder="例：天井高を活かした開放的な空間に">
    </div>
    <div class="case-form-field">
      <label class="case-form-label">施工写真</label>
      <div class="case-img-upload" id="caseImgZone" onclick="document.getElementById('caseImgInput').click()">
        <div id="caseImgPreviewWrap">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <div style="font-size:12px;color:#555;margin-top:6px;">タップして写真を選択</div>
        </div>
        <input type="file" id="caseImgInput" accept="image/*" style="display:none" onchange="previewCaseImg(event)">
      </div>
    </div>
    <button class="case-submit" id="caseSubmitBtn" onclick="submitCase()">事例を登録する</button>
    <div id="caseMsg" style="font-size:12px;color:#7ab87a;text-align:center;margin-top:8px;display:none;">✓ 登録しました！</div>
  `;
}

function previewCaseImg(e) {
  const file = e.target.files[0];
  if (!file) return;
  caseImgFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    caseImgData = ev.target.result;
    document.getElementById('caseImgPreviewWrap').innerHTML =
      `<img class="case-img-preview" src="${caseImgData}" alt="preview">`;
  };
  reader.readAsDataURL(file);
}

async function submitCase() {
  const title  = document.getElementById('cf-title').value.trim();
  const room   = document.getElementById('cf-room').value.trim();
  const style  = document.getElementById('cf-style').value.trim();
  const budget = document.getElementById('cf-budget').value.trim();
  const desc   = document.getElementById('cf-desc').value.trim();
  if (!title || !room) { alert('タイトルと部屋名は必須です'); return; }

  const btn = document.getElementById('caseSubmitBtn');
  btn.disabled = true; btn.textContent = '登録中...';

  try {
    let imageKey = '';
    if (caseImgFile && EDGE_URL) {
      const presignRes = await fetch(EDGE_URL, { method: 'POST', headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken, type: 'create_upload_url', filename: caseImgFile.name, content_type: caseImgFile.type }) });
      const presign = await presignRes.json();
      if (!presignRes.ok) throw new Error(presign.error || '画像アップロードの準備に失敗しました');
      const put = await fetch(presign.upload_url, { method: 'PUT', headers: { 'Content-Type': presign.content_type }, body: caseImgFile });
      if (!put.ok) throw new Error('画像をS3へアップロードできませんでした');
      imageKey = presign.key;
    }
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sessionToken, type: 'save_case',
        title, room, style, budget_range: budget,
        description: desc, image_key: imageKey,
      })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '登録に失敗しました');
    }
    const msg = document.getElementById('caseMsg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
    // Reset form
    caseImgData = '';
    caseImgFile = null;
    renderUploadForm();
  } catch(e) {
    alert('登録に失敗しました: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function renderCasesList() {
  document.getElementById('casesBody').innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:20px;">読み込み中...</div>';
  try {
    const res  = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_cases', room:'', style:'' })
    });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      document.getElementById('casesBody').innerHTML = '<div style="color:#444;font-size:13px;text-align:center;padding:30px;">まだ事例がありません</div>';
      return;
    }
    document.getElementById('casesBody').innerHTML = data.map(c => {
      const imageSrc = safeImageSrc(c.image_url || c.image_data);
      const encodedId = encodeURIComponent(String(c.id || ''));
      return `<div class="case-list-item">
        ${imageSrc ? `<img class="case-list-img" src="${escapeHTML(imageSrc)}" alt="">` : `<div class="case-list-img" style="display:flex;align-items:center;justify-content:center;color:#2a2a2a;font-size:10px;">NO IMG</div>`}
        <div class="case-list-info">
          <div class="case-list-title">${escapeHTML(c.title || '—')}</div>
          <div class="case-list-tags">
            ${c.room   ? `<span class="case-list-tag">${escapeHTML(c.room)}</span>` : ''}
            ${c.style  ? `<span class="case-list-tag">${escapeHTML(c.style)}</span>` : ''}
            ${c.budget_range ? `<span class="case-list-tag">${escapeHTML(c.budget_range)}</span>` : ''}
          </div>
        </div>
        <button class="case-list-del" onclick="deleteCase(decodeURIComponent('${encodedId}'))">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('casesBody').innerHTML = `<div style="color:#c07070;font-size:12px;text-align:center;padding:20px;">${escapeHTML(e.message)}</div>`;
  }
}

async function deleteCase(id) {
  if (!confirm('この事例を削除しますか？')) return;
  await fetch(EDGE_URL, {
    method: 'POST',
    headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken, type: 'delete_case', id })
  });
  renderCasesList();
}

// ── Show Cases in chat ──
async function showCases(room, style) {
  const chat = document.getElementById('chat');
  const loading = document.createElement('div');
  loading.className = 'msg agent'; loading.id = 'cases-loading';
  loading.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
    <div class="bubble agent"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(loading); scrollBottom();

  try {
    const res  = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_cases', room, style })
    });
    const data = await res.json();
    document.getElementById('cases-loading')?.remove();

    const div = document.createElement('div');
    div.className = 'msg agent';

    if (!Array.isArray(data) || data.length === 0) {
      div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
        <div class="bubble agent">まだ施工事例が登録されていません。<br>担当者に直接お問い合わせください。</div>`;
    } else {
      const cards = data.map(c => {
        const imageSrc = safeImageSrc(c.image_url || c.image_data);
        return `<div class="case-chat-card">
          ${imageSrc ? `<img class="case-chat-img" src="${escapeHTML(imageSrc)}" alt="">` : `<div class="case-chat-img" style="display:flex;align-items:center;justify-content:center;color:#333;font-size:10px;">NO IMAGE</div>`}
          <div class="case-chat-body">
            <div class="case-chat-title">${escapeHTML(c.title || '施工事例')}</div>
            <div class="case-chat-tag">${escapeHTML([c.room, c.style, c.budget_range].filter(Boolean).join(' · '))}</div>
          </div>
        </div>`;
      }).join('');

      div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
        <div class="bubble agent">
          ${room || style ? `${escapeHTML([room,style].filter(Boolean).join('・'))}の施工事例です。` : '施工事例の一覧です。'}参考にしてみてください！
          <div class="case-cards">${cards}</div>
        </div>`;
    }
    chat.appendChild(div);
    renderSuggestions(['画像で確認する', '概算を見る', 'このスタイルで進めたい', '提案書を作成']);
    scrollBottom();
  } catch(e) {
    document.getElementById('cases-loading')?.remove();
    addAgentMessage('事例の読み込みに時間がかかっています。別の方法で相談を続けられます。', null, null,
      ['素材を探す', '概算を見る', '担当者に相談', '相談内容を続ける']);
  }
}

// ── Session History ──
async function autoSaveSession(afterSrc) {
  try {
    // Extract structured info from conversation. Chat mock mode stays local.
    const info = MOCK_CHAT_MODE
      ? getMockConversationSummary(history)
      : await fetchConversationSummary();

    // Store image URL (data URL → truncate for storage efficiency)
    const imgToStore = afterSrc.startsWith('data:')
      ? afterSrc.substring(0, 8000)  // thumbnail-ish
      : afterSrc;

    await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: sessionToken, type: 'save_session',
        room: info.room || '—',
        parts: info.parts || '—',
        style: info.style || '—',
        budget: info.budget || '—',
        summary: info.summary || '',
        after_image_url: imgToStore,
      })
    });
  } catch(e) {
    console.warn('Session save failed:', e.message);
  }
}

async function openHistoryPanel() {
  document.getElementById('historyPanel').classList.add('open');
  const list = document.getElementById('historyList');
  list.innerHTML = '<div class="history-empty">読み込み中...</div>';

  try {
    const res  = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_sessions' })
    });
    const data = await res.json();
    const sessions = Array.isArray(data) ? data : (Array.isArray(data?.sessions) ? data.sessions : []);

    if (sessions.length === 0) {
      list.innerHTML = '<div class="history-empty">まだ履歴がありません。<br>ヒアリングを完了すると<br>ここに保存されます。</div>';
      return;
    }

    list.innerHTML = sessions.map(s => {
      const date = new Date((s.createdAt || 0) * 1000).toLocaleDateString('ja-JP', {
        month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
      });
      const sessionId = escapeJSString(s.sessionId || '');
      return `<div class="session-card" role="button" tabindex="0" onclick="resumeSession('${sessionId}')">
        <div class="session-img-placeholder">CHAT</div>
        <div class="session-body">
          <div class="session-date">${date}</div>
          <div class="session-tags">
            <span class="session-tag">${escapeHTML(s.status || 'active')}</span>
            ${s.messageCount ? `<span class="session-tag">${s.messageCount}件</span>` : ''}
          </div>
          ${s.title ? `<div class="session-summary">${escapeHTML(s.title)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    list.innerHTML = `<div class="history-empty">読み込みに失敗しました。<br>${escapeHTML(e.message)}</div>`;
  }
}

async function persistPhotoUpload(file) {
  if (!EDGE_URL || !sessionToken || !file) return;
  const sessionId = await ensureSession();
  const presignRes = await fetchWithTimeout(EDGE_URL, { method: 'POST', headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken, type: 'create_upload_url', sessionId, filename: file.name, content_type: file.type }) });
  const presign = await presignRes.json();
  if (!presignRes.ok) throw new Error(presign.error || '写真のアップロードURLを取得できませんでした');
  const put = await fetchWithTimeout(presign.upload_url, { method: 'PUT', headers: { 'Content-Type': presign.content_type }, body: file }, 60000);
  if (!put.ok) throw new Error('写真をS3へアップロードできませんでした');
  const savedRes = await fetchWithTimeout(EDGE_URL, { method: 'POST', headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken, type: 'save_photo', sessionId, key: presign.key, filename: file.name, content_type: file.type }) });
  const saved = await savedRes.json();
  if (!savedRes.ok) throw new Error(saved.error || '写真と相談履歴を紐付けできませんでした');
  window._lastPhoto = saved.photo;
}

async function resumeSession(sessionId) {
  if (!sessionId || !EDGE_URL) return;
  try {
    const res = await fetchWithTimeout(EDGE_URL, {
      method: 'POST',
      headers: { ...EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, type: 'get_session', sessionId }),
    });
    const data = await res.json();
    if (!res.ok || !data?.session) throw new Error(data?.error || '相談履歴を開けませんでした');
    setActiveSessionId(data.session.sessionId);
    history = Array.isArray(data.session.messages) ? data.session.messages : [];
    document.getElementById('chat').innerHTML = '';
    finalizationState = 'draft';
    finalHandoffStarted = false;
    restoreCachedChat(history);
    persistChatHistory();
    persistChatState('');
    closeHistoryPanel();
    scrollBottom();
  } catch (e) {
    const list = document.getElementById('historyList');
    if (list) list.innerHTML = `<div class="history-empty">${escapeHTML(e.message || '履歴を開けませんでした')}</div>`;
  }
}

function closeHistoryPanel() {
  document.getElementById('historyPanel').classList.remove('open');
}

function closeHistory(e) {
  if (e.target === document.getElementById('historyPanel')) closeHistoryPanel();
}

// ── Quick Form ──
function showQuickForm(def) {
  // Parse: "部屋|opt1,opt2 :: 箇所|opt1,opt2"
  const sections = def.split('::').map(s => s.trim());
  const parsed = sections.map(sec => {
    const [label = '', opts = ''] = sec.split('|');
    return {
      label: label.trim(),
      opts: opts.split(',').map(o => o.trim()).filter(Boolean),
    };
  }).filter(sec => sec.label && sec.opts.length);
  if (!parsed.length) {
    addAgentMessage('選択フォームを表示できませんでした。文章でご希望を入力してください。');
    return;
  }

  const formId = 'qf-' + Date.now();
  const state = {}; // { sectionIndex: Set of selected }
  parsed.forEach((_, i) => state[i] = new Set());

  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.id = formId + '-msg';

  function render() {
    const sectionsHtml = parsed.map((sec, si) => `
      <div class="qf-section">
        <div class="qf-label">${escapeHTML(sec.label)}</div>
        <div class="qf-chips">
          ${sec.opts.map(opt => {
            const encodedOpt = encodeURIComponent(opt);
            return `
            <button class="qf-chip ${state[si].has(opt) ? 'selected' : ''}"
              onclick="qfToggle('${formId}',${si},decodeURIComponent('${encodedOpt}'))">
              ${escapeHTML(opt)}
            </button>`;
          }).join('')}
        </div>
      </div>`).join('');

    const hasAll = parsed.every((_, i) => state[i].size > 0);
    div.innerHTML = `<div class="avatar agent">${getAgentIconHTML()}</div>
      <div class="bubble agent">
        <div class="quick-form">
          ${sectionsHtml}
          <button class="qf-submit" ${hasAll ? '' : 'disabled'} onclick="qfSubmit('${formId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            ${hasAll ? 'まとめて送る' : '各項目を選んでください'}
          </button>
        </div>
      </div>`;
  }

  window[formId + '_state'] = state;
  window[formId + '_parsed'] = parsed;
  window[formId + '_render'] = render;

  render();
  chat.appendChild(div);
  scrollBottom();
}

window.qfToggle = function(formId, si, opt) {
  const state = window[formId + '_state'];
  const parsed = window[formId + '_parsed'];
  // single select per section
  state[si].clear();
  state[si].add(opt);
  window[formId + '_render']();
  scrollBottom();
};

window.qfSubmit = function(formId) {
  const state = window[formId + '_state'];
  const parsed = window[formId + '_parsed'];
  const parts = parsed.map((sec, i) => `${sec.label}：${[...state[i]].join('・')}`).join('、');
  const text = parts;

  document.getElementById(formId + '-msg')?.remove();
  removeSuggestions();
  addUserMessage(text);
  history.push({ role: 'user', content: text });
  callAgent();
};

async function sendMessage() {
  const input = document.getElementById('userInput');
  const text  = input.value.trim();
  if (!text || document.getElementById('sendBtn').disabled) return;
  input.value = ''; input.style.height = 'auto';
  removeSuggestions();
  playSound('send');
  addUserMessage(text);
  history.push({ role:'user', content: text });
  await callAgent();
  document.getElementById('userInput').focus();
}

async function getMockAgentResponse(messages) {
  await new Promise(resolve => setTimeout(resolve, 550));
  const userMessages = messages.filter(message => message.role === 'user').map(message => String(message.content || ''));
  const latest = userMessages[userMessages.length - 1] || '';
  const normalized = latest.toLowerCase();
  const hasPhoto = Boolean(window._beforeFile || window._beforeURL);
  const room = ['リビング', 'キッチン', '浴室', '洗面所', '寝室', '玄関', '和室'].find(value => latest.includes(value));

  if (/事例|施工例|参考写真/.test(latest)) {
    return '雰囲気の近い施工事例をご案内します。[SHOW_CASES: , ]';
  }
  if (/概算|いくら|費用|予算|工期|補助金/.test(latest)) {
    return '条件を選びながら、費用の目安を確認できます。[SHOW_SIMULATOR]';
  }
  if (/素材.*(詳しく|詳細)|耐久|お手入れ|メンテナンス/.test(latest)) {
    return '候補の素材について、特徴やお手入れのしやすさを確認できます。[SHOW_MATERIAL: composite]';
  }

  if (userMessages.length <= 1 && room) {
    return `${room}ですね。どの部分を変えたいとお考えですか？\n[SUGGESTIONS: 床材, 壁紙, キッチン設備, 照明, 収納]`;
  }
  if (userMessages.length <= 1) {
    return 'ありがとうございます。まず、リフォームしたいお部屋を教えてください。\n[SUGGESTIONS: リビング, キッチン, 浴室・洗面所, 寝室, 玄関]';
  }
  if (/日当たり|明る|光|照明/.test(normalized)) {
    return '日当たりを活かして、明るく開放的な空間にしたいのですね☀️\n現状写真があれば、光の入り方を残したナチュラルなイメージを作成できます。\n[SUGGESTIONS: 📷 写真を撮る・選ぶ, 概算を見る, 担当者に相談]';
  }
  if (userMessages.length === 2) {
    return 'ご希望の箇所が分かりました。どんな雰囲気にしたいですか？\n[SUGGESTIONS: モダン, ナチュラル, 和風, インダストリアル, 北欧風]';
  }
  if (!hasPhoto) {
    const concern = latest.trim() ? `「${latest.trim()}」も大切なポイントですね。` : 'ご希望を整理しました。';
    return `${concern}\n今のお部屋の写真があれば、雰囲気を保ちながら施工後イメージを作れます。写真を撮って送ってみてください。\n[SUGGESTIONS: 📷 写真を撮る・選ぶ]`;
  }
  return 'ご希望を反映した施工後イメージを作成できます。写真の準備ができたら、次のステップへ進みましょう。\n[SUGGESTIONS: 施工後イメージ, 概算を見る, 担当者に相談]';
}

function addTemplateTurn(userText, reply, suggestions) {
  addUserMessage(userText);
  history.push({ role: 'user', content: userText });
  const raw = `${reply}\n[SUGGESTIONS: ${suggestions.join(', ')}]`;
  addAgentMessage(reply, null, null, suggestions);
  history.push({ role: 'assistant', content: raw });
  persistChatHistory();
}

async function callAgent() {
  const requestToken = chatResetToken;
  document.getElementById('sendBtn').disabled = true;
  persistChatHistory();
  addTyping();
  try {
    // 初回メッセージ送信時に、AI呼び出しより先にセッションを作成する。
    await ensureSession();
    let raw = '';
    const templateResponse = getTemplateAgentResponse(history);
    if (templateResponse) {
      raw = templateResponse;
    } else if (MOCK_CHAT_MODE) {
      raw = await getMockAgentResponse(history);
    } else {
      const res  = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { ...EDGE_HEADERS, 'Content-Type':'application/json' },
        body: JSON.stringify({ token: sessionToken, type:'chat', sessionId: currentSessionId, system: SYSTEM_PROMPT, messages: history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'APIエラー');
      updateUsageAfterGen(data.usage);
      raw = data.content?.[0]?.text || '';
      if (!raw.trim()) throw new Error('AIから空の応答が返されました');
    }
    if (requestToken !== chatResetToken) return;
    if (templateResponse || MOCK_CHAT_MODE) {
      const latestUserMessage = [...history].reverse().find(message => message.role === 'user')?.content || '';
      await saveMockChatTurn(latestUserMessage, raw);
    }
    removeTyping();
    if (MOCK_CHAT_MODE && !templateResponse) {
      addAgentMessage('\u73fe\u5728\u306fAI\u306b\u63a5\u7d9a\u3057\u3066\u3044\u306a\u3044\u305f\u3081\u3001\u30c7\u30e2\u5fdc\u7b54\u3092\u8868\u793a\u3057\u3066\u3044\u307e\u3059\u3002');
    }

    // Parse tags
    const genMatch   = raw.match(/\[GENERATE_IMAGE:\s*([\s\S]+?)\]/);
    const simMatch   = raw.match(/\[SHOW_SIMULATOR\]/);
    const matMatch   = raw.match(/\[SHOW_MATERIAL:\s*(\w+)\]/);
    const casesMatch = raw.match(/\[SHOW_CASES:\s*([^,\]]*),?\s*([^\]]*)\]/);
    const qfMatch    = raw.match(/\[QUICK_FORM:\s*([\s\S]+?)\]/);
    const sugMatch   = raw.match(/\[SUGGESTIONS:\s*(.+?)\]/);
    const suggestions = sugMatch
      ? sugMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : ['写真をアップロード', '概算を見る', '相談を続ける'];

    let display = raw
      .replace(/\[GENERATE_IMAGE:[\s\S]+?\]/, '')
      .replace(/\[SHOW_SIMULATOR\]/, '')
      .replace(/\[SHOW_MATERIAL:\s*\w+\]/, '')
      .replace(/\[SHOW_CASES:[^\]]*\]/, '')
      .replace(/\[QUICK_FORM:[\s\S]+?\]/, '')
      .replace(/\[SUGGESTIONS:.+?\]/, '')
      .trim();

    if (genMatch) {
      if (display) addAgentMessage(display);
      history.push({ role:'assistant', content: raw });
      if (window._beforeFile || window._beforeURL) {
        // 既に写真がある場合は再アップロードさせず、その写真のまま再生成する
        window._genPrompt = genMatch[1].trim();
        generateWithFiles(window._beforeFile, null);
      } else {
        // 初回のみ写真アップロードを求める
        showUploadCard(genMatch[1].trim());
      }
    } else if (simMatch) {
      if (display) addAgentMessage(display);
      history.push({ role:'assistant', content: raw });
      showSimulator();
    } else if (matMatch) {
      if (display) addAgentMessage(display);
      history.push({ role:'assistant', content: raw });
      showMaterial(matMatch[1].trim());
    } else if (casesMatch) {
      if (display) addAgentMessage(display);
      history.push({ role:'assistant', content: raw });
      showCases(casesMatch[1].trim(), casesMatch[2].trim());
    } else if (qfMatch) {
      if (display) addAgentMessage(display);
      history.push({ role:'assistant', content: raw });
      showQuickForm(qfMatch[1].trim());
    } else {
      addAgentMessage(display, null, null, suggestions);
      history.push({ role:'assistant', content: raw });
    }

  } catch(e) {
    if (requestToken !== chatResetToken) return;
    removeTyping();
    addAgentMessage('一時的に応答を取得できませんでした。相談を続けるか、もう一度送信できます。', null, null,
      ['もう一度送る', '担当者に相談', '相談内容を続ける']);
  }
  persistChatHistory();
  document.getElementById('sendBtn').disabled = false;
}


Object.assign(window, { fetchWithTimeout, safeLocalGet, safeLocalSet, initAudioCtx, toggleSE, playSound, initIconPicker, getSelectedChar, openQrModal, closeQrModal, switchQrTab, copyQrUrl, copyUrlAndNotify, saveAuthSession, restoreCachedSession, clearAuthSession, initLoginView, showGuestPinManually, startDemoSession, pinKey, pinDel, renderDots, escapeHTML, safeImageSrc, escapeJSString, applySession, toggleUserMenu, switchGoogleAccount, checkPin, cognitoRequest, loginWithCognito, loginWithGoogle, handleGoogleRedirect, openAdminLogin, logoutApp, resetClientCache, lockApp, chatCacheKey, chatStateKey, persistChatHistory, persistChatState, persistCurrentChatState, restoreChatState, clearDraftCache, resetConversation, restoreCachedChat, restoreInteractiveSuggestions, initChat, autoResize, scrollBottom, getIconForEmotion, getAgentIconHTML, removeSuggestions, renderSuggestions, tapChip, addUserMessage, addTyping, removeTyping, showUploadCard, useSampleImage, handlePhoto, showIdealImageCard, startPhotoDiagnosis, startCatalogFromDiagnosis, startEstimateFromDiagnosis, startGenerationFromPhoto, getHandoffSummary, handoffToStaff, submitHandoff, startProposalFlow, handleIdealPhoto, generateWithFiles, getFallbackImage, srcToBlob, shareViaLine, shareNative, renderMaterialCandidates, requestMaterialRecommendation, stars, showMaterial, generateNight, showDayNight, switchDN, getMockConversationSummary, fetchConversationSummary, getPdfConversationSummary, generatePDF, calcCost, fmtMoney, updateSimResult, getEstimateCacheKey, readEstimateCache, writeEstimateCache, applyEstimateResult, requestEstimate, getEstimateDurationLabel, showSimulator, simSetSize, simToggleItem, simSetGrade, refreshSim, showFinalConfirmation, completeFinalConsultation, reselectEstimate, returnToEarlierStep, simConfirm, fetchUsage, renderUsageBadge, updateUsageAfterGen, showUpgradeModal, closeUpgradeModal, openGuestPinPanel, closeGuestPinPanel, closeGuestPinOuter, renderGpinPanel, gpinSetDays, gpinSetUses, issueGuestPin, showGpinResult, copyGpinUrl, generateQR, copyGpinInfo, shareGpin, loadGuestPins, deleteGuestPin, openMenuSheet, closeMenuSheet, closeMenuOuter, openCasesPanel, closeCasesPanel, closeCasesOuter, switchCasesTab, renderCasesTab, renderUploadForm, previewCaseImg, submitCase, renderCasesList, deleteCase, showCases, autoSaveSession, openHistoryPanel, resumeSession, closeHistoryPanel, closeHistory, showQuickForm, render, sendMessage, getMockAgentResponse, callAgent });

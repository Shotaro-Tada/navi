// ---- モバイル/ブラウザ用 window.navi shim (Capacitor 版 NAVI) ----
// Electron では preload.cjs が window.navi を提供するため、ここでは「何もしない」。
// window.navi が未定義のとき (= Capacitor WebView / 通常ブラウザ) のみ、PC 側リレーサーバ
// (src/relay.js: GET /health, POST /ask, GET /memory/index) への HTTP 実装で window.navi を定義する。
// 接続先は localStorage の naviRelayUrl / naviRelayToken。未設定なら初回に window.prompt で聞く。
// index.html では app.js より前に読み込むこと (app.js が読み込み時に window.navi を参照するため)。
(() => {
  'use strict';
  if (window.navi) return; // Electron preload 環境 — 何もしない

  const LS_URL = 'naviRelayUrl';
  const LS_TOKEN = 'naviRelayToken';
  const LS_MODEL = 'naviModelTier';
  const LS_GH_TOKEN = 'naviGhToken'; // GitHub fine-grained PAT (navi-memory の Contents:Read のみ)
  const LS_GH_REPO = 'naviGhRepo';   // 既定 'Shotaro-Tada/navi-memory'
  const PC_ONLY = 'この機能は PC 側でのみ利用できます。';

  // ---- リレー接続設定 (localStorage) ----
  function getRelay() {
    let url = '';
    let token = '';
    try {
      url = localStorage.getItem(LS_URL) || '';
      token = localStorage.getItem(LS_TOKEN) || '';
    } catch { /* localStorage 不可なら未設定扱い */ }
    return { url: url.replace(/\/+$/, ''), token };
  }

  function saveRelay(url, token) {
    try {
      localStorage.setItem(LS_URL, url);
      localStorage.setItem(LS_TOKEN, token);
    } catch { /* 保存不可でも今回のセッションは動かす (下の sessionRelay) */ }
  }

  let sessionRelay = null; // localStorage が使えない環境向けのセッション内保持

  // URL 未設定なら window.prompt の簡易セットアップで聞く。
  // interactive=true のときだけ prompt を出す (起動時1回と、未設定のまま ask した時のみ。
  // profile/getTheme 等の内部 fetch では出さない — キャンセル時に prompt が連発するのを防ぐ)。
  function ensureRelay(interactive) {
    if (sessionRelay) return sessionRelay;
    const cur = getRelay();
    if (cur.url || !interactive) return cur;
    const u = window.prompt(
      'PC 側 NAVI のリレー URL を入力してください\n例: http://192.168.1.10:17760 (PC の config.json で relay.enabled を true に)',
      'http://'
    );
    if (!u || !/^https?:\/\/.+/.test(u.trim())) return cur; // キャンセル/無効入力 — 次の機会にまた聞く
    const t = window.prompt('リレートークン (PC の config.json の relay.token)', '') || '';
    const url = u.trim().replace(/\/+$/, '');
    const token = t.trim();
    saveRelay(url, token);
    sessionRelay = { url, token };
    return sessionRelay;
  }

  // タイムアウト付き fetch (既定6秒) — 不達ホストで起動処理がハングするのを防ぐ
  function fetchWithTimeout(url, options, ms = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...(options || {}), signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  // timeoutMs は用途別: 軽い照会=6秒 / 会話 (/ask)=240秒 (モデルの思考時間) / 同期=60秒 (git push)
  async function relayFetch(pathname, options, interactive, timeoutMs = 6000) {
    const { url, token } = ensureRelay(interactive);
    if (!url) throw new Error('リレー URL が未設定です (送信時に再度設定できます)');
    try {
      const res = await fetchWithTimeout(url + pathname, {
        ...(options || {}),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options && options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      }, timeoutMs);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      window.__naviRelayError = null; // 成功したら診断をクリア
      return data;
    } catch (err) {
      const msg = err && err.name === 'AbortError'
        ? `タイムアウト (${Math.round(timeoutMs / 1000)}秒)`
        : String(err?.message ?? err);
      window.__naviRelayError = `${pathname}: ${msg}`; // 起動診断用に最後の失敗を記録
      throw new Error(msg);
    }
  }

  // ---- GitHub 直読み (PC オフライン時の記憶フォールバック、読み取り専用) ----
  // 非公開リポ navi-memory を fine-grained PAT (Contents:Read のみ) で読む。HTTPS なので
  // cleartext 制約とも無縁。会話はできない — 記憶の閲覧と挨拶の正常化のみ。
  function getGh() {
    let token = '';
    let repo = '';
    try {
      token = localStorage.getItem(LS_GH_TOKEN) || '';
      repo = localStorage.getItem(LS_GH_REPO) || '';
    } catch { /* 未設定扱い */ }
    return { token, repo: repo || 'Shotaro-Tada/navi-memory' };
  }

  async function ghReadFile(path) {
    const { token, repo } = getGh();
    if (!token) throw new Error('GitHub トークン未設定');
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=main`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' } },
      8000
    );
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    return await res.text();
  }

  // ---- イベント購読 (preload の ipcRenderer.on 相当) ----
  const listeners = { chunk: [], done: [], error: [] };
  // reminder / update-available / memstatus はモバイル側では発火しない (購読のみ受け付ける)
  const subscribeNoop = () => { /* PC 側のみのイベント */ };

  async function doAsk(text) {
    try {
      const data = await relayFetch('/ask', { method: 'POST', body: JSON.stringify({ text }) }, true, 240000);
      const reply = String(data.reply ?? '');
      // ストリーミングは無いので、返答全文を 1 チャンクとして通知してから done
      listeners.chunk.forEach((cb) => cb(reply));
      listeners.done.forEach((cb) => cb());
    } catch (err) {
      listeners.error.forEach((cb) => cb(String(err?.message ?? err)));
    }
  }

  // ---- profile: 記憶索引から名前/呼び方を抽出 (agent.js getProfile と同じ規則) ----
  // 取得元の優先順: PC リレー → GitHub 直読み (PC オフライン時) → /health → 既定値。
  function parseProfile(mem) {
    const naviSection = mem.split(/^## /m).find((s) => /^(わたし|NAVI)/.test(s));
    const nameMatch = naviSection
      ? naviSection.match(/^-[^\n]*名前[:：]\s*\**([^*\n（(]+)/m)
      : null;
    const operatorMatch = mem.match(/^-[^\n]*呼び方[:：][^\n]*?「([^」\n]+)」/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : '',
      operator: operatorMatch ? operatorMatch[1].trim() : '',
    };
  }

  async function profile() {
    let name = '';
    let operator = '';
    window.__naviProfileSource = null;
    try {
      const p = parseProfile(String((await relayFetch('/memory/index')).index ?? ''));
      name = p.name; operator = p.operator;
      if (name) window.__naviProfileSource = 'relay';
    } catch { /* リレー不達 — GitHub 直読みへ */ }
    if (!name) {
      try {
        const p = parseProfile(await ghReadFile('NAVI_MEMORY.md'));
        name = p.name; operator = p.operator;
        if (name) window.__naviProfileSource = 'github';
      } catch { /* GitHub も不可なら /health へ */ }
    }
    if (!name) {
      try {
        name = String((await relayFetch('/health')).name || '');
      } catch { /* 未接続でも既定値で起動する */ }
    }
    return { name: name || 'NAVI', operator: operator || 'オペレーター様' };
  }

  // ---- getTheme: アプリ同梱の izanami テーマを fetch で読む簡易版 ----
  // Capacitor では CI が themes/ を webDir (renderer/) 内へ複製するので 1 つ目で当たる。
  // プロジェクト直下をブラウザで開いた場合は 2 つ目 (../themes/) で当たる。
  async function getTheme() {
    for (const p of ['themes/izanami/theme.json', '../themes/izanami/theme.json']) {
      try {
        const res = await fetchWithTimeout(p, null, 4000);
        if (!res.ok) continue;
        const t = await res.json();
        return { name: t.name, char: t.char, bg: t.bg };
      } catch { /* 次の候補へ */ }
    }
    return null; // sprite.js 内蔵の izanami 既定描画にフォールバック
  }

  // ---- getConfig: モバイルにチュートリアルは無いので tutorialDone 固定 ----
  async function getConfig() {
    let model = 'sonnet';
    try {
      model = localStorage.getItem(LS_MODEL) || 'sonnet';
    } catch { /* 既定 sonnet */ }
    if (!['sonnet', 'opus', 'fable'].includes(model)) model = 'sonnet';
    return { model, language: 'ja', tutorialDone: true };
  }

  window.navi = {
    ask: (text) => { doAsk(String(text)); },
    onChunk: (cb) => listeners.chunk.push(cb),
    onDone: (cb) => listeners.done.push(cb),
    onError: (cb) => listeners.error.push(cb),
    profile,
    getConfig,
    getTheme,

    // モデルタブ: 表示状態のみ保存 (実際のモデルは PC 側 config が決める)
    setModel: (tier) => {
      try { localStorage.setItem(LS_MODEL, String(tier)); } catch { /* 保存不可は無視 */ }
    },

    // ☾ 手動同期: PC のリレー経由で記憶を GitHub と同期させる。
    // PC 不達で GitHub トークンがあれば、代わりに記憶索引を閲覧表示する (読み取り専用)
    syncMemory: async () => {
      try {
        return String((await relayFetch('/sync', { method: 'POST', body: '{}' }, true, 60000)).result || '☾ 同期しました');
      } catch (err) {
        try {
          const mem = await ghReadFile('NAVI_MEMORY.md');
          const lines = mem.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('>'));
          return `☾ PC に届かないため、GitHub の記憶索引を表示します (読み取り専用):\n${lines.slice(0, 25).join('\n')}`;
        } catch {
          return `☾ 同期できません: ${String(err?.message ?? err)}`;
        }
      }
    },

    // ---- PC 側でのみ利用できる機能 (noop) ----
    consolidate: async () => PC_ONLY,
    inspire: async () => null, // null は app.js 側で「何もしない」扱い
    generateTheme: async () => ({ ok: false, error: PC_ONLY }),
    checkAuth: async () => true, // 認証は PC 側で済んでいる前提 (チュートリアル自体出さない)
    applySetup: async () => ({ ok: false, error: PC_ONLY }),
    voiceAvailable: async () => false,
    transcribe: async () => { throw new Error(PC_ONLY); },
    voiceFallback: async () => false,

    // PC 側のみのイベント — 購読だけ受け付けて何も発火しない
    onReminderStart: subscribeNoop,
    onUpdateAvailable: subscribeNoop,
    onMemStatus: subscribeNoop,

    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
    close: () => { /* モバイルでは閉じない */ },
    minimize: () => { /* モバイルでは最小化しない */ },

    // 接続先の再設定 (app.js が STANDBY 表示タップで呼ぶ)。保存済み設定を消して聞き直す。
    // 追加で GitHub 直読み (PC オフライン時の記憶閲覧) のトークンも任意入力できる
    reconfigureRelay: () => {
      try {
        localStorage.removeItem(LS_URL);
        localStorage.removeItem(LS_TOKEN);
      } catch { /* 消せなくても prompt で上書きされる */ }
      sessionRelay = null;
      const r = ensureRelay(true);
      const gh = window.prompt(
        'GitHub トークン (任意 — PC オフライン時に記憶を直読みする用。navi-memory の Contents:Read 権限のみの fine-grained PAT を推奨。空のままでも可)',
        getGh().token
      );
      if (gh !== null) {
        try {
          localStorage.setItem(LS_GH_TOKEN, gh.trim());
          if (!localStorage.getItem(LS_GH_REPO)) localStorage.setItem(LS_GH_REPO, 'Shotaro-Tada/navi-memory');
        } catch { /* 保存不可は無視 */ }
      }
      return !!(r && r.url);
    },
  };

  // ---- Android ネイティブ音声認識 (Capacitor プラグイン、存在する時のみ有効化) ----
  // 長押し → Google の音声入力ダイアログ → 認識結果を返す。voice.js がこの API の有無で分岐する。
  const SR = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
  if (SR) {
    window.navi.voiceAvailable = async () => {
      try {
        const r = await SR.available();
        return !!(r && (r.available !== undefined ? r.available : r));
      } catch {
        return false;
      }
    };
    window.navi.nativeVoiceStart = async (lang) => {
      try {
        if (SR.requestPermissions) await SR.requestPermissions();
      } catch { /* 拒否されていれば start が失敗して通知される */ }
      const res = await SR.start({
        language: lang === 'en' ? 'en-US' : 'ja-JP',
        partialResults: false,
        popup: true,
      });
      const m = res && res.matches;
      return m && m[0] ? String(m[0]) : '';
    };
  }

  // 初回 (URL 未設定) はこの場で同期的に接続設定を聞く。
  // <script> は順次実行されるため、この prompt は app.js の起動処理 (profile() 等の relayFetch)
  // より必ず先に完了する — 設定済みの状態で挨拶に正しい名前が出る。
  if (!getRelay().url) {
    try { ensureRelay(true); } catch { /* prompt 不可環境では ask 時に再試行 */ }
  }
})();

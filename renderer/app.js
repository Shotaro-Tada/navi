const chat = document.getElementById('chat');
const form = document.getElementById('input-area');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('navi-status');

// sprite はテーマ取得後に初期化する (起動シーケンス末尾の async bootstrap 参照)
let sprite = null;
const aura = new NaviAura(document.getElementById('aura-canvas'));
const fx = new NaviFX(document.getElementById('fx-canvas'));

document.getElementById('btn-close').addEventListener('click', () => window.navi.close());
document.getElementById('btn-min').addEventListener('click', () => window.navi.minimize());

let currentNaviMsg = null;
let currentTier = 'sonnet';
let appBusy = false;
let lastEmotion = null;

const TIER_LABEL = { sonnet: 'SONNET', opus: 'OPUS', fable: 'FABLE' };

// ---- URL リンク化 ----
// テキスト中の https?:// URL を <a> に変換して el へ追記する。
// innerHTML は使わず text ノードと <a> 要素を組み立てる (XSS 防止)。
// URL は ASCII のみ (日本語文が直後に続くケースで巻き込まないため非 ASCII を除外)
const URL_RE = /https?:\/\/[^\s<>"'\u0060\u0080-\uffff]+/g;

function appendLinkified(el, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // 文末の句読点・括弧閉じはリンクに含めない
    const url = m[0].replace(/[.,;:!?)\]}>]+$/, '');
    if (!url) continue;
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.title = url;
    el.appendChild(a);
    last = m.index + url.length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

// リンクは Electron 内で開かず既定ブラウザへ (クリックは #chat で委譲)
chat.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  window.navi.openExternal(a.href);
});

function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  appendLinkified(div, text);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function setBusy(busy, label) {
  appBusy = busy;
  sendBtn.disabled = busy;
  statusEl.textContent = busy
    ? (label || 'PROCESSING…')
    : `STANDBY · ${TIER_LABEL[currentTier] ?? 'SONNET'}`;
  sprite?.setTalking(busy);
}

// ---- 感情タグ ([emo:joy] 等) の抽出と除去 ----
const EMO_RE = /\s*\[emo:(joy|blush|sad|none)\]\s*/g;
function stripEmotion(text) {
  let emo = null;
  const clean = text.replace(EMO_RE, (_m, e) => { emo = e; return ' '; }).trimEnd();
  return { clean, emo };
}

// ---- モデル切替タブ + オーラ ----
const tabs = Array.from(document.querySelectorAll('#model-tabs button'));

function applyTier(tier, announce) {
  currentTier = tier;
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.tier === tier));
  aura.setTier(tier);
  setBusy(appBusy);
  if (announce) {
    const note = {
      sonnet: '祈りを日常の灯に戻しました (Sonnet)。',
      opus: '強い祈りを捧げます — 金色のオーラ (Opus)。',
      fable: '最大の祈りを捧げます — 光輝のオーラ (Fable)。祈りの力の消費にご留意を。',
    }[tier];
    if (note) addMsg('reminder', `⚙ ${note}`);
  }
}

tabs.forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.tier === currentTier) return;
    window.navi.setModel(b.dataset.tier);
    applyTier(b.dataset.tier, true);
  });
});

// ---- 会話 ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || appBusy) return;
  addMsg('user', text);
  input.value = '';
  currentNaviMsg = null;
  lastEmotion = null;
  setBusy(true);
  window.navi.ask(text);
});

window.navi.onChunk((text) => {
  const { clean, emo } = stripEmotion(text);
  if (emo) lastEmotion = emo;
  if (!clean) return;
  if (!currentNaviMsg) currentNaviMsg = addMsg('navi', '');
  // textContent への代入はリンク要素を壊すため、ノード追記でチャンクを継ぎ足す
  if (currentNaviMsg.hasChildNodes()) currentNaviMsg.appendChild(document.createTextNode('\n'));
  appendLinkified(currentNaviMsg, clean);
  chat.scrollTop = chat.scrollHeight;
});

window.navi.onDone(() => {
  setBusy(false);
  currentNaviMsg = null;
  if (lastEmotion && lastEmotion !== 'none') {
    sprite?.showEmotion(lastEmotion);
  }
  lastEmotion = null;
});

window.navi.onError((msg) => {
  addMsg('error', `通信エラー: ${msg}`);
  setBusy(false);
  currentNaviMsg = null;
  sprite?.showEmotion('sad', 3500);
});

// ---- 🔊 読み上げ (VOICEVOX、PC 版のみ) ----
// main が応答全文を WAV (navi:speak-wav) で送ってくる。Blob → Audio で再生し、
// 多重発話は前の再生を止めてから。トグル OFF 中は受信しても再生しない。
const voiceBtn = document.getElementById('btn-voice');
let voiceEnabled = true;
let voiceAudio = null;
let voiceAudioUrl = null;

function updateVoiceBtn() {
  voiceBtn.textContent = voiceEnabled ? '🔊' : '🔇';
  voiceBtn.title = voiceEnabled ? '読み上げ ON (VOICEVOX) — クリックで OFF' : '読み上げ OFF — クリックで ON';
  voiceBtn.classList.toggle('off', !voiceEnabled);
}

function stopVoice() {
  if (voiceAudio) {
    try { voiceAudio.pause(); } catch { /* 再生前の pause 失敗は無視 */ }
    voiceAudio = null;
  }
  if (voiceAudioUrl) {
    URL.revokeObjectURL(voiceAudioUrl);
    voiceAudioUrl = null;
  }
}

function playVoiceWav(wav) {
  if (voiceBtn.style.display === 'none') voiceBtn.style.display = ''; // エンジンが後から起動した場合にトグルを出す
  if (!voiceEnabled || !wav) return;
  stopVoice(); // 多重発話防止: 前の再生を止めてから
  voiceAudioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const audio = new Audio(voiceAudioUrl);
  voiceAudio = audio;
  audio.onended = () => { if (voiceAudio === audio) stopVoice(); };
  audio.play().catch(() => { if (voiceAudio === audio) stopVoice(); });
}

if (typeof window.navi.onSpeakWav === 'function') window.navi.onSpeakWav(playVoiceWav);

voiceBtn.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  if (!voiceEnabled) stopVoice();
  updateVoiceBtn();
  if (typeof window.navi.setVoice === 'function') window.navi.setVoice(voiceEnabled); // config.voice.enabled へ永続化
});

// ---- ♪ BGM (和風ループ、renderer/assets/bgm.wav — build/make_bgm.py で合成) ----
// 既定 ON。ブラウザ/Electron の自動再生制限があるため、最初のユーザー操作
// (click / keydown) を待って再生を開始する。トグル状態は localStorage に永続化
// (モバイル = navi-shim 環境でも効くように config ではなく localStorage)。
const bgmEl = document.getElementById('bgm');
const bgmBtn = document.getElementById('btn-bgm');
let bgmEnabled = localStorage.getItem('bgmEnabled') !== 'off';
let bgmUnlocked = false; // 最初のユーザー操作を受けたか (自動再生制限の解除)
bgmEl.volume = 0.35;

function updateBgmBtn() {
  bgmBtn.title = bgmEnabled ? 'BGM ON — クリックで OFF' : 'BGM OFF — クリックで ON';
  bgmBtn.classList.toggle('off', !bgmEnabled);
}

function syncBgm() {
  if (bgmEnabled && bgmUnlocked) {
    bgmEl.play().catch(() => { /* 再生拒否 (自動再生制限など) は次のユーザー操作 ♪ で再試行 */ });
  } else {
    bgmEl.pause();
  }
}

function unlockBgm() {
  bgmUnlocked = true;
  syncBgm();
}
window.addEventListener('click', unlockBgm, { once: true });
window.addEventListener('keydown', unlockBgm, { once: true });

bgmBtn.addEventListener('click', () => {
  bgmEnabled = !bgmEnabled;
  localStorage.setItem('bgmEnabled', bgmEnabled ? 'on' : 'off');
  updateBgmBtn();
  syncBgm();
});
updateBgmBtn();

// ---- 定時リマインド ----
window.navi.onReminderStart(() => {
  addMsg('reminder', '⏰ 定時リマインド');
  currentNaviMsg = null;
  setBusy(true, 'REMINDING…');
});

// ---- 起動時バージョン確認 (main が GitHub の version.json と比較して通知) ----
window.navi.onUpdateAvailable((info) => {
  if (!info?.version) return;
  const lines = [`🔔 新しいバージョン v${info.version} が公開されています。`];
  if (info.notes) lines.push(String(info.notes));
  if (info.url) lines.push(String(info.url));
  addMsg('reminder', lines.join('\n'));
});

// ---- ☾ 記憶の GitHub 同期 (手動トリガー、Win=IPC / Android=リレー /sync) ----
document.getElementById('btn-sync').addEventListener('click', async () => {
  if (appBusy) return;
  setBusy(true, 'SYNCING…');
  try {
    const result = window.navi.syncMemory
      ? await window.navi.syncMemory()
      : 'この版は ☾ 同期に未対応です (アプリを更新してください)';
    addMsg('reminder', result || '☾ 同期完了');
  } catch (err) {
    addMsg('error', `同期エラー: ${err}`);
  }
  setBusy(false);
});

// ---- ⛩ 記憶の固定化 (手動トリガー) ----
document.getElementById('btn-slp').addEventListener('click', async () => {
  if (appBusy) return;
  setBusy(true, 'MEMORIZING…');
  try {
    const report = await window.navi.consolidate();
    addMsg('navi', stripEmotion(report || '記憶の固定化が完了いたしました。').clean);
  } catch (err) {
    addMsg('error', `固定化エラー: ${err}`);
  }
  setBusy(false);
});

// アプリ終了時の自動固定化の進行表示
window.navi.onMemStatus((status) => {
  if (status === 'saving') {
    setBusy(true, 'MEMORIZING…');
    addMsg('navi', '本日の記憶を社に納めております。少々お待ちくださいませ…');
  }
});

// ---- 暮らしの演出ディレクター (30秒ごとに抽選、会話中は休止) ----
const IDLE_P = { sweep: 0.08, star: 0.04, novelty: 0.002 }; // 掃除8% / 流れ星4% / 新奇0.2% (各30秒抽選)

function noveltyAvailableToday() {
  const today = new Date().toISOString().slice(0, 10);
  return localStorage.getItem('noveltyDate') !== today;
}

async function triggerNovelty() {
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem('noveltyDate', today); // 失敗しても1日1回まで
  const res = await window.navi.inspire();
  if (!res || appBusy) return;
  fx.weather(res.effect, 25000);
  if (res.line) addMsg('reminder', `✨ ${stripEmotion(res.line).clean}`);
}

setInterval(() => {
  if (!sprite || appBusy || sprite.isBusy() || fx.busy) return;
  const r = Math.random();
  if (r < IDLE_P.sweep) {
    // 箒を取り出して境内を掃く
    fx.startDust();
    sprite.playAction('sweep', 9000, () => fx.stopDust());
  } else if (r < IDLE_P.sweep + IDLE_P.star) {
    // 流れ星 → 祈り
    fx.shootingStar(() => sprite?.playAction('pray', 4500));
  } else if (r < IDLE_P.sweep + IDLE_P.star + IDLE_P.novelty && noveltyAvailableToday()) {
    triggerNovelty();
  }
}, 30000);

// ---- 起動処理: テーマ → キャラ/背景を初期化し、設定+プロフィールを UI に反映して挨拶 ----
(async () => {
  // 1. テーマ (キャラのドット絵 + 背景)。取得失敗時は sprite.js 内蔵の izanami 既定で描く
  let theme = null;
  try {
    theme = await window.navi.getTheme();
  } catch { /* 組み込み既定で続行 */ }
  const charData = theme?.char ?? { palette: window.__NAVI_PALETTE, frames: window.__NAVI_FRAMES };
  sprite = new NaviSprite(document.getElementById('navi-canvas'), charData);
  window.drawNaviBg(document.getElementById('bg-canvas'), theme?.bg);

  // 2. 設定 (モデル階梯 + 読み上げトグル)
  try {
    const cfg = await window.navi.getConfig();
    if (cfg?.model) applyTier(cfg.model, false);
    if (cfg?.voice) {
      voiceEnabled = cfg.voice.enabled !== false;
      updateVoiceBtn();
    }
  } catch { /* 既定 sonnet で続行 */ }

  // 2b. 読み上げ可否 (VOICEVOX エンジン稼働中の PC のみ 🔊 を表示。
  //     後からエンジンが起動した場合は最初の WAV 受信時に playVoiceWav が再表示する)
  try {
    const ttsOk = typeof window.navi.voiceTtsAvailable === 'function'
      ? await window.navi.voiceTtsAvailable()
      : false;
    if (!ttsOk) voiceBtn.style.display = 'none';
  } catch {
    voiceBtn.style.display = 'none';
  }

  // 3. プロフィール (永続記憶の名前/呼び方) と挨拶
  let profile = null;
  try {
    profile = await window.navi.profile();
  } catch { /* 既定値で続行 */ }
  const name = profile?.name || 'NAVI';
  const operator = profile?.operator || 'オペレーター様';
  input.placeholder = `${name}に話しかける…`;
  document.getElementById('title').textContent = `NAVI.exe — ${name}`;
  setBusy(false);
  addMsg('navi', `お帰りなさいませ、${operator}。${name}、お側に控えております。本日はいかがなさいますか?`);
  // モバイル起動診断: リレーへの通信が失敗していたら理由と復旧手順を表示する
  if (window.__naviProfileSource === 'github') {
    addMsg('reminder', '☆ PC に届かないため、記憶を GitHub から直読みしています (閲覧モード)。会話には PC の NAVI が必要です。☾ タップで記憶索引を表示できます。');
  } else if (window.__naviRelayError) {
    addMsg('error', `PC に接続できませんでした (${window.__naviRelayError})。Tailscale の接続と PC の NAVI 稼働を確認してください。上部の STANDBY 表示をタップすると接続先 (URL/トークン/GitHub) を再設定できます。`);
  }
  input.focus();
})();

// STANDBY 表示のタップで接続先を再設定 (モバイルのみ — shim が reconfigureRelay を提供する)
statusEl.addEventListener('click', () => {
  if (typeof window.navi.reconfigureRelay !== 'function') return;
  if (window.navi.reconfigureRelay()) {
    addMsg('reminder', '☆ 接続先を更新しました。アプリを再起動すると挨拶から反映されます。');
  }
});

// ---- モバイル初回起動の自己修復 ----
// 接続情報 (リレー URL/トークン) の入力が挨拶の描画より後になった場合、
// プロフィールが既定値 (NAVI/オペレーター様) のまま表示されてしまう。
// 最初の応答が成功した時点でプロフィールを取り直し、表示を正す。
let profileRefreshTried = false;
window.navi.onDone(async () => {
  if (profileRefreshTried) return;
  profileRefreshTried = true;
  if (!document.getElementById('title').textContent.endsWith('— NAVI')) return; // 既に正しい名前
  try {
    const p = await window.navi.profile();
    if (p?.name && p.name !== 'NAVI') {
      input.placeholder = `${p.name}に話しかける…`;
      document.getElementById('title').textContent = `NAVI.exe — ${p.name}`;
      addMsg('reminder', `☆ 接続が確立しました — ${p.name} がお側におります、${p.operator || 'オペレーター様'}。`);
    }
  } catch { /* 次回起動時の通常フローに任せる */ }
});

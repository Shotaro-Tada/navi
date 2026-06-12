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

function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
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
  currentNaviMsg.textContent += (currentNaviMsg.textContent ? '\n' : '') + clean;
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

// ---- 定時リマインド ----
window.navi.onReminderStart(() => {
  addMsg('reminder', '⏰ 定時リマインド');
  currentNaviMsg = null;
  setBusy(true, 'REMINDING…');
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

  // 2. 設定 (モデル階梯)
  try {
    const cfg = await window.navi.getConfig();
    if (cfg?.model) applyTier(cfg.model, false);
  } catch { /* 既定 sonnet で続行 */ }

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
  input.focus();
})();

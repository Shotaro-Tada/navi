// 初回チュートリアル (v0.7)
// - config.tutorialDone が true なら一切表示しない。
// - 4ステップ: ようこそ+AI設定 / 言語 / 人格と舞台 / 完了。
// - 「自動生成」を選んだ場合は window.__openGeneratorAfterTutorial = true を立てるだけ
//   (生成パネル本体は別部品。main 側の win.reload() を越えるため localStorage で中継する)。
(async () => {
  const GEN_FLAG_KEY = 'naviOpenGeneratorAfterTutorial';

  // reload 越えの生成パネルフラグ復元 (チュートリアル完了直後の再読み込みで拾う)
  try {
    if (localStorage.getItem(GEN_FLAG_KEY) === '1') {
      localStorage.removeItem(GEN_FLAG_KEY);
      window.__openGeneratorAfterTutorial = true;
    }
  } catch { /* localStorage 不可でも続行 */ }

  let cfg = null;
  try {
    cfg = await window.navi.getConfig();
  } catch { /* 設定が取れない時は表示しない (安全側) */ }
  if (!cfg || cfg.tutorialDone) return;

  const overlay = document.getElementById('tutorial');
  const steps = Array.from(overlay.querySelectorAll('.tut-step'));
  const dots = Array.from(overlay.querySelectorAll('#tut-dots span'));
  const backBtn = document.getElementById('tut-back');
  const nextBtn = document.getElementById('tut-next');
  const summaryEl = document.getElementById('tut-summary');

  // 選択状態 (既定: 日本語 / イザナミ)
  const sel = {
    language: cfg.language === 'en' ? 'en' : 'ja',
    theme: ['izanami', 'kaguya'].includes(cfg.theme) ? cfg.theme : 'izanami',
  };

  // カード選択の配線
  function wireCards(attr, apply) {
    const cards = Array.from(overlay.querySelectorAll(`.tut-card[${attr}]`));
    const sync = () => cards.forEach((c) => c.classList.toggle('selected', c.getAttribute(attr) === apply.get()));
    cards.forEach((c) => c.addEventListener('click', () => { apply.set(c.getAttribute(attr)); sync(); }));
    sync();
  }
  wireCards('data-lang', { get: () => sel.language, set: (v) => { sel.language = v; } });
  wireCards('data-theme', { get: () => sel.theme, set: (v) => { sel.theme = v; } });

  // Step1: Claude 認証の確認
  const authEl = document.getElementById('tut-auth-status');
  window.navi.checkAuth()
    .then((ok) => {
      authEl.textContent = ok ? '✓ Claude 設定済み' : '未設定 — 上記手順をご確認ください';
      authEl.classList.toggle('ok', !!ok);
      authEl.classList.toggle('ng', !ok);
    })
    .catch(() => {
      authEl.textContent = '認証状態を確認できませんでした';
      authEl.classList.add('ng');
    });

  // ステップ遷移
  let step = 1;
  const LAST = 4;
  function showStep(n) {
    step = n;
    steps.forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === n));
    dots.forEach((d) => d.classList.toggle('on', Number(d.dataset.dot) === n));
    backBtn.disabled = n === 1;
    nextBtn.textContent = n === LAST ? 'はじめる ⛩' : '進む →';
    if (n === LAST) {
      const langLabel = sel.language === 'en' ? 'English' : '日本語';
      const themeLabel = {
        izanami: 'イザナミ (巫女 × 神社の夜)',
        kaguya: 'カグヤ (月の姫 × 月面)',
        auto: '自動生成 (完了後に生成パネルが開きます)',
      }[sel.theme] || sel.theme;
      summaryEl.textContent = `言語: ${langLabel}\n人格と舞台: ${themeLabel}`;
    }
  }

  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    backBtn.disabled = true;
    nextBtn.disabled = true;
    nextBtn.textContent = '準備中…';
    if (sel.theme === 'auto') {
      window.__openGeneratorAfterTutorial = true;
      try { localStorage.setItem(GEN_FLAG_KEY, '1'); } catch { /* 揮発でも続行 */ }
    }
    try {
      // main 側: config 更新 (language/theme/tutorialDone) + 記憶索引の名前置換 +
      // resetSession + setPersonaCharacter + win.reload()
      await window.navi.applySetup({
        language: sel.language,
        theme: sel.theme === 'auto' ? null : sel.theme,
      });
      overlay.classList.add('hidden'); // 通常は直後に reload されるが保険で隠す
    } catch {
      finishing = false;
      backBtn.disabled = step === 1;
      nextBtn.disabled = false;
      nextBtn.textContent = 'はじめる ⛩';
    }
  }

  backBtn.addEventListener('click', () => { if (step > 1) showStep(step - 1); });
  nextBtn.addEventListener('click', () => {
    if (step < LAST) showStep(step + 1);
    else finish();
  });

  showStep(1);
  overlay.classList.remove('hidden');
})();

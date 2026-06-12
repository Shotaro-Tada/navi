// ドット絵自動生成パネル (v0.8)
// - タイトルバーの ✎ から #genpanel を開き、説明文を main の navi:generate-theme へ送る。
// - 成功時は main 側がテーマ適用 + win.reload() するため、ここでは結果表示のみ。
// - チュートリアルで「自動生成」を選ぶと tutorial.js が localStorage 経由で
//   window.__openGeneratorAfterTutorial を立てる → reload 後に自動でパネルを開く
//   (本スクリプトは tutorial.js より後に読み込まれる前提)。
(function () {
  const panel = document.getElementById('genpanel');
  const descEl = document.getElementById('gen-desc');
  const statusLine = document.getElementById('gen-status');
  const runBtn = document.getElementById('gen-run');
  const cancelBtn = document.getElementById('gen-cancel');
  const openBtn = document.getElementById('btn-gen');
  const naviStatus = document.getElementById('navi-status');
  const chatInput = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  let generating = false;

  function setStatus(text, isError) {
    statusLine.textContent = text;
    statusLine.classList.toggle('hidden', !text);
    statusLine.classList.toggle('error', !!isError);
  }

  function setGenerating(on) {
    generating = on;
    runBtn.disabled = on;
    cancelBtn.disabled = on;
    descEl.disabled = on;
    // 生成中は会話も止める (main 側も chatBusy でガードしている)
    chatInput.disabled = on;
    sendBtn.disabled = on;
  }

  function openPanel() {
    if (!generating) setStatus('', false);
    panel.classList.remove('hidden');
    if (!generating) descEl.focus();
  }

  function closePanel() {
    if (generating) return; // 生成中は閉じない (結果待ち)
    panel.classList.add('hidden');
  }

  async function run() {
    const description = descEl.value.trim();
    if (generating) return;
    if (!description) {
      setStatus('説明を入力してください。', true);
      return;
    }
    setGenerating(true);
    const prevStatus = naviStatus.textContent;
    naviStatus.textContent = 'CREATING…';
    setStatus('描き起こしています… (数分かかることがあります)', false);
    let failMsg = '';
    try {
      const res = await window.navi.generateTheme(description);
      if (res && res.ok) {
        // 成功: main 側がテーマ適用済みで、まもなく画面が読み直される
        setStatus(`「${res.name || '新しい人格'}」が顕現します…`, false);
        return;
      }
      failMsg = (res && res.error) || '原因不明';
    } catch (err) {
      failMsg = String(err);
    }
    setStatus(`生成に失敗しました: ${failMsg}`, true);
    setGenerating(false);
    naviStatus.textContent = prevStatus;
  }

  openBtn.addEventListener('click', openPanel);
  cancelBtn.addEventListener('click', closePanel);
  runBtn.addEventListener('click', run);

  // チュートリアルで「自動生成」を選んだ直後の reload で自動オープン
  if (window.__openGeneratorAfterTutorial) {
    window.__openGeneratorAfterTutorial = false;
    openPanel();
  }
})();

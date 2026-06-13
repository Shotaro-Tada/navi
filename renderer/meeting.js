// 会議録音エンジン (マイク + システム音声ループバック)。
// トレイメニュー (main) からの navi:meeting-control {action,language} で開始/停止する。
// マイク (getUserMedia) とシステム音声 (getDisplayMedia — main の
// setDisplayMediaRequestHandler が loopback を許可) を AudioContext で 1 ストリームに
// 混合し、MediaRecorder (audio/webm;codecs=opus) で 30秒ごとのチャンクを
// navi:meeting-chunk として main へ送る。ファイル追記と保存は main 側。
// 録音中も会話可能 (appBusy にはしない)。#navi-status に 'LISTENING● 分:秒' を表示する。
// app.js の後に読み込まれる前提 (statusEl / addMsg / setBusy / appBusy を共有)。
(() => {
  // preload (PC 版) が無い環境 — Capacitor/ブラウザの navi-shim — では何もしない
  if (typeof window.navi?.onMeetingControl !== 'function') return;

  const CHUNK_MS = 30000; // dataavailable の間隔 (30秒ごとに main へ追記)

  let recording = false;
  let starting = false; // ストリーム取得中 (二重開始ガード)
  let language = 'ja';
  let micStream = null;
  let sysStream = null;
  let mixCtx = null;
  let recorder = null;
  let startedAt = 0;
  let timerId = null;
  let chunkQueue = Promise.resolve(); // チャンク送出の順序保証 (最終チャンク→stop の順を守る)

  // タイトルバーの 🎙 ボタン (PC 環境のみ表示)。トレイの 🎙 と同じ機能の主動線。
  const meetingBtn = document.getElementById('btn-meeting');
  if (meetingBtn) {
    meetingBtn.style.display = ''; // PC でのみ表示 (mobile は冒頭の early-return で隠れたまま)
    meetingBtn.addEventListener('click', () => {
      if (recording) stop();
      else start('auto'); // 自動判定 — 日英混在の会議でも言語を選ばず始められる
    });
  }

  function releaseStreams() {
    try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* 停止済みなら無視 */ }
    try { sysStream?.getTracks().forEach((t) => t.stop()); } catch { /* 同上 */ }
    micStream = null;
    sysStream = null;
    recorder = null;
    const ctx = mixCtx;
    mixCtx = null;
    if (ctx) ctx.close().catch(() => { /* close 失敗は無視 */ });
  }

  // ---- 録音中ステータス表示 ----
  // 1秒ごとに 'LISTENING● 分:秒' を上書きする。会話処理中 (appBusy) は
  // PROCESSING… 等の表示を邪魔しないよう書き換えを見送る (次の tick で復帰)。
  function elapsedStr() {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function updateStatus() {
    if (!recording || appBusy) return;
    statusEl.textContent = `LISTENING● ${elapsedStr()}`;
    statusEl.classList.add('recording');
  }

  function clearStatus() {
    clearInterval(timerId);
    timerId = null;
    statusEl.classList.remove('recording');
    reflectButton();
    if (!appBusy) setBusy(appBusy); // STANDBY 表示へ戻す (会話中なら onDone に任せる)
  }

  // タイトルバー 🎙 ボタンの見た目を録音状態に同期する (トレイ操作・ボタン操作の両方を反映)
  function reflectButton() {
    if (!meetingBtn) return;
    meetingBtn.classList.toggle('recording', recording);
    meetingBtn.title = recording
      ? '会議の拝聴を終了'
      : '会議を拝聴 (クリックで開始・自動判定)';
  }

  // ---- 開始 / 停止 ----
  async function start(lang) {
    if (recording || starting) return;
    starting = true;
    language = ['ja', 'en', 'auto'].includes(lang) ? lang : 'ja';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // システム音声: video は Electron の仕様上要求が必須なだけなので、取得直後に止める
      sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      sysStream.getVideoTracks().forEach((t) => t.stop());

      // マイク + ループバックを 1 ストリームへ混合
      mixCtx = new AudioContext();
      const dest = mixCtx.createMediaStreamDestination();
      mixCtx.createMediaStreamSource(micStream).connect(dest);
      const sysTracks = sysStream.getAudioTracks();
      if (sysTracks.length) {
        mixCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
      }

      recorder = new MediaRecorder(dest.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 64000,
      });
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        // arrayBuffer() が非同期でもチャンクの送出順は崩さない (直列化)
        const blob = e.data;
        chunkQueue = chunkQueue.then(async () => {
          window.navi.meetingChunk(await blob.arrayBuffer());
        }).catch(() => { /* 1チャンク欠落しても録音は継続 */ });
      };
      recorder.onstop = () => {
        // 最終チャンクの送出を待ってから main にファイルを閉じさせる
        chunkQueue.then(() => window.navi.meetingStop({ language }));
        releaseStreams();
        clearStatus();
      };

      window.navi.meetingStart({ language }); // 先に main 側でファイルを開かせる
      recorder.start(CHUNK_MS);
      recording = true;
      startedAt = Date.now();
      timerId = setInterval(updateStatus, 1000);
      updateStatus();
      reflectButton();
      const langLabel = { ja: '日本語', en: 'English', auto: '自動判定' }[language];
      addMsg('reminder', `🎙 会議を拝聴しております (${langLabel})。終了はトレイの「⏹ 拝聴を終了」から。録音中も会話できます。`);
    } catch (err) {
      releaseStreams();
      clearStatus();
      addMsg('error', `会議録音を開始できませんでした: ${String(err?.message ?? err)}`);
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (!recording) return;
    recording = false;
    try {
      recorder?.stop(); // onstop → 最終チャンク送出 → navi:meeting-stop → 解放
    } catch {
      // recorder が既に止まっていた場合の保険: 直接閉じる
      chunkQueue.then(() => window.navi.meetingStop({ language }));
      releaseStreams();
      clearStatus();
    }
  }

  // ---- main (トレイメニュー) からの開始/停止指示 ----
  window.navi.onMeetingControl((cmd) => {
    if (cmd?.action === 'start') start(cmd.language);
    else if (cmd?.action === 'stop') stop();
  });

  // 保存完了・エラー等の通知 (main の onMeetingRecorded 暫定実装が送ってくる)
  if (typeof window.navi.onMeetingStatus === 'function') {
    window.navi.onMeetingStatus((msg) => addMsg('reminder', String(msg)));
  }
})();

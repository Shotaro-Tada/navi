// 送信ボタン長押しで音声入力 (Windows SAPI 経由)。
// #send を 500ms 長押しすると録音開始、離すと 16kHz mono 16bit WAV にエンコードして
// main プロセスの navi:transcribe (System.Speech) へ送り、結果を input に追記する。
// 通常クリック (テキスト送信) とは干渉しない — 長押し成立時のみ click を抑止する。
// app.js の後に読み込まれる前提 (input / sendBtn / statusEl / addMsg / setBusy / appBusy を共有)。
(() => {
  const LONG_PRESS_MS = 500;
  const TARGET_RATE = 16000; // SAPI 向け 16kHz mono

  let pressTimer = null; // 長押し判定タイマー (短押しなら clear され通常 click に任せる)
  let suppressClick = false; // 長押し成立後の click (form submit) を1回だけ抑止
  let starting = false; // getUserMedia 等の準備中
  let stopRequested = false; // 準備中に指が離された場合の中断フラグ
  let recording = false;
  let mediaStream = null;
  let audioCtx = null;
  let source = null;
  let processor = null;
  let chunks = []; // Float32Array の蓄積
  let inputRate = 48000; // 実際は AudioContext.sampleRate で上書き
  let statusTimer = null;
  let voiceLang = 'ja';

  window.navi.getConfig()
    .then((cfg) => { voiceLang = cfg?.language === 'en' ? 'en' : 'ja'; })
    .catch(() => { /* 既定 ja で続行 */ });

  // ---- PCM ユーティリティ ----
  function mergeChunks(list) {
    let len = 0;
    for (const c of list) len += c.length;
    const out = new Float32Array(len);
    let off = 0;
    for (const c of list) { out.set(c, off); off += c.length; }
    return out;
  }

  // 区間平均で間引くダウンサンプル (平均が簡易ローパスを兼ねる)
  function downsample(samples, fromRate, toRate) {
    if (fromRate <= toRate) return samples;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  // Float32 PCM → 16bit mono WAV (RIFF) の ArrayBuffer
  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt チャンク長
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  // ---- UI ----
  function setRecordingUI(on) {
    sendBtn.classList.toggle('recording', on);
    sendBtn.textContent = on ? '🎤' : '▶';
    if (on) statusEl.textContent = 'RECORDING…';
  }

  // ステータスを一時表示し、ms 後に通常表示へ戻す
  function flashStatus(text, ms) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusTimer = setTimeout(() => setBusy(appBusy), ms);
  }

  function releaseAudio() {
    try { processor?.disconnect(); } catch { /* 切断済みなら無視 */ }
    try { source?.disconnect(); } catch { /* 同上 */ }
    try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch { /* 同上 */ }
    const ctx = audioCtx;
    processor = null;
    source = null;
    mediaStream = null;
    audioCtx = null;
    if (ctx) ctx.close().catch(() => { /* close 失敗は無視 */ });
  }

  // ---- 録音開始 / 停止 ----
  async function startRecording() {
    starting = true;
    stopRequested = false;
    try {
      const available = await window.navi.voiceAvailable().catch(() => true);
      if (!available) {
        // 内蔵エンジンが無い言語では Windows 標準の音声入力 (Win+H) を代わりに起動する
        document.getElementById('input').focus();
        addMsg('reminder', '🎤 内蔵の音声認識エンジンが無いため、Windows の音声入力 (Win+H) を起動します。入力欄に向かってお話しください。');
        window.navi.voiceFallback?.();
        return;
      }
      if (stopRequested) return;
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopRequested) { releaseAudio(); return; } // 準備中に離された
      audioCtx = new AudioContext();
      inputRate = audioCtx.sampleRate;
      chunks = [];
      source = audioCtx.createMediaStreamSource(mediaStream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      recording = true;
      setRecordingUI(true);
      if (stopRequested) stopRecording(); // connect 直前に離された場合の保険
    } catch (err) {
      releaseAudio();
      addMsg('error', `マイクを開けませんでした: ${String(err?.message ?? err)}`);
      setBusy(appBusy);
    } finally {
      starting = false;
    }
  }

  async function stopRecording() {
    if (!recording) return;
    recording = false;
    setRecordingUI(false);
    releaseAudio();
    const samples = mergeChunks(chunks);
    chunks = [];
    if (samples.length < inputRate * 0.2) { // 0.2秒未満は無音扱い
      flashStatus('(聞き取れませんでした)', 2000);
      input.focus();
      return;
    }
    statusEl.textContent = 'TRANSCRIBING…';
    try {
      const wav = encodeWav(downsample(samples, inputRate, TARGET_RATE), TARGET_RATE);
      const text = String((await window.navi.transcribe(wav)) ?? '').trim();
      if (text) {
        input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + text;
        setBusy(appBusy);
      } else {
        flashStatus('(聞き取れませんでした)', 2000);
      }
    } catch (err) {
      addMsg('error', `音声認識エラー: ${String(err?.message ?? err)}`);
      setBusy(appBusy);
    }
    input.focus();
  }

  // ---- 長押し判定 (pointer events) ----
  sendBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    suppressClick = false; // 前回分の抑止フラグが残っていたら解除
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true; // 長押し成立 — このあとの click (submit) は抑止
      startRecording();
    }, LONG_PRESS_MS);
  });

  // ボタン外で離しても確実に止まるよう window で受ける
  function onRelease() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; return; } // 短押し → 通常 click に任せる
    if (recording) stopRecording();
    else if (starting) stopRequested = true;
  }
  window.addEventListener('pointerup', onRelease);
  window.addEventListener('pointercancel', onRelease);

  // 長押し成立時のみ click を捕捉段階で握り潰す (テキスト送信と干渉させない)
  sendBtn.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
})();

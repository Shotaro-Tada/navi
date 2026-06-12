import electron from 'electron';
const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, Notification, Tray, nativeImage, session, shell } = electron;
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, createWriteStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ask, consolidateMemory, getProfile, setModelTier, inspire, generateTheme,
  setPersonaCharacter, setLanguage, resetSession, MEMORY_DIR, MEMORY_PATH,
} from './agent.js';
import { startRelay } from './relay.js';
import { speak, isTtsAvailable, ensureEngineRunning } from './tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
// データ領域: パッケージ時は userData 配下、開発時はリポジトリ直下 (agent.js と同じ規約)
const DATA_ROOT = app.isPackaged ? app.getPath('userData') : APP_ROOT;
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const THEMES_DIR = path.join(APP_ROOT, 'themes'); // 同梱プリセット (読み取りのみ)
const CUSTOM_THEMES_DIR = path.join(DATA_ROOT, 'themes', 'custom'); // 生成テーマ置き場
const SEED_MEMORY_DIR = path.join(APP_ROOT, 'seed', 'memory'); // 初期記憶の雛形 (同梱)

// パッケージ初回起動時: 同梱の seed/memory を userData/memory へコピーする。
// asar 内からの読み出しは readFileSync/readdirSync で行う (cpSync は asar 非対応のため使わない)。
function ensureSeedMemory() {
  if (!app.isPackaged || existsSync(MEMORY_PATH)) return;
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    for (const name of readdirSync(SEED_MEMORY_DIR)) {
      const dst = path.join(MEMORY_DIR, name);
      if (!existsSync(dst)) writeFileSync(dst, readFileSync(path.join(SEED_MEMORY_DIR, name)));
    }
  } catch { /* seed が無くても起動は続行 (記憶なしで動く) */ }
}
ensureSeedMemory();

// ---- 設定 (config.json に永続化) ----
const CONFIG_DEFAULTS = {
  model: 'sonnet', // sonnet | opus | fable
  theme: 'izanami', // themes/<id>/theme.json
  language: 'ja', // 'ja' | 'en' — 応答言語
  tutorialDone: false, // 初回チュートリアル完了済みか
  reminder: { enabled: true, time: '07:00', lastFired: '' },
  relay: { enabled: false, port: 17760, token: '' }, // Android 版の入口 (src/relay.js)
  // VOICEVOX 読み上げ (src/tts.js)。enginePath: run.exe の明示パス (空なら既知の場所を自動探索)
  voice: { enabled: true, speakerName: '九州そら', styleName: 'ノーマル', enginePath: '' },
  tray: { closeToTray: true }, // true: ×はトレイへ隠すだけ (終了はトレイの「固定化して終了」)
  meeting: {
    model: 'small', // 議事録の文字起こしモデル (small | medium — scripts/transcribe.py --model)
    // 定例ミーティングの拝聴提案 (day: 0=日…6=土)。該当時刻に通知するだけで、
    // 録音の自動開始はしない (同意マナーのため、必ず人がトレイの 🎙 から開始する)
    suggest: [
      { day: 4, time: '12:55', label: '旭先生 定例' },
      { day: 5, time: '12:55', label: '髙見先生 定例' },
    ],
  },
};

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    return {
      ...CONFIG_DEFAULTS,
      ...parsed,
      reminder: { ...CONFIG_DEFAULTS.reminder, ...(parsed.reminder ?? {}) },
      relay: { ...CONFIG_DEFAULTS.relay, ...(parsed.relay ?? {}) },
      voice: { ...CONFIG_DEFAULTS.voice, ...(parsed.voice ?? {}) },
      tray: { ...CONFIG_DEFAULTS.tray, ...(parsed.tray ?? {}) },
      meeting: { ...CONFIG_DEFAULTS.meeting, ...(parsed.meeting ?? {}) },
    };
  } catch {
    return structuredClone(CONFIG_DEFAULTS);
  }
}

const config = loadConfig();
function saveConfig() {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch { /* 保存失敗は致命的でない */ }
}

setModelTier(config.model);
setLanguage(config.language);

// ---- テーマ ----
// 探索順: 同梱プリセット themes/<id> → データ領域 themes/<id> (生成テーマ custom_<ts>、
// パッケージ時は userData 側) → 旧置き場 themes/custom/<id>
function readThemeFile(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error(`invalid theme id: ${id}`);
  const candidates = [
    path.join(THEMES_DIR, String(id), 'theme.json'),
    path.join(DATA_ROOT, 'themes', String(id), 'theme.json'),
    path.join(CUSTOM_THEMES_DIR, String(id), 'theme.json'),
  ];
  const file = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadTheme(id) {
  try {
    return readThemeFile(id);
  } catch {
    try {
      return readThemeFile('izanami'); // 読めなければ izanami にフォールバック
    } catch {
      return null; // izanami も無ければ renderer/agent の組み込み既定で動く
    }
  }
}

let theme = loadTheme(config.theme);
if (theme?.personaCharacter) setPersonaCharacter(theme.personaCharacter);
let themeName = theme?.name || 'イザナミ';

let win = null;
let quitting = false;
let chatBusy = false;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 620,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: '#0d1322',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 閉じる操作を一度横取りする。closeToTray 有効時は隠すだけで常駐を続け
  // (リレー・リマインドは動き続ける)、終了はトレイの「⛩ 記憶を固定化して終了」から。
  // 無効時は従来どおり記憶を固定化してから終了する。
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (config.tray.closeToTray) win.hide();
    else shutdownWithConsolidation();
  });
}

async function shutdownWithConsolidation() {
  if (quitting) return;
  quitting = true;
  try {
    win?.webContents.send('navi:memstatus', 'saving');
    await Promise.race([
      consolidateMemory(),
      new Promise((resolve) => setTimeout(resolve, 60000)),
    ]);
  } catch {
    // 固定化失敗でも終了を妨げない
  }
  // 固定化後の記憶を GitHub へ push (最大10秒待ち、間に合わなければ次回の push に委ねる)
  await Promise.race([
    syncMemoryPush(),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  app.exit(0);
}

// ---- 記憶の GitHub 自動同期 (memory/ は独立 git リポ: navi-memory 非公開) ----
// git を memory/ ディレクトリで実行する。失敗 (オフライン・コンフリクト等) は
// 呼び出し側で握りつぶし、アプリの動作を妨げない。
function gitMemory(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: MEMORY_DIR, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout));
    });
  });
}

// 起動時 pull: 他PCで固定化された記憶を取り込む (--ff-only なのでコンフリクト時は何もしない)
async function syncMemoryPull() {
  try {
    await gitMemory(['pull', '--ff-only']);
    const send = () => win?.webContents.send('navi:memstatus', 'synced');
    if (!win) return;
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  } catch (err) {
    console.log('[memory-sync] pull skipped:', err?.message ?? err);
  }
}

// 固定化後 push: add → commit → push。変更が無ければ commit が exit 1 となり、
// そのまま終了する。push 失敗は無視 (次回の push でまとめて反映される)。
async function syncMemoryPush() {
  try {
    await gitMemory(['add', '-A']);
    try {
      await gitMemory(['commit', '-m', `memory consolidation ${new Date().toISOString()}`]);
    } catch {
      return; // コミットすべき変更なし
    }
    await gitMemory(['push']);
  } catch (err) {
    console.log('[memory-sync] push skipped:', err?.message ?? err);
  }
}

// ☾ 手動同期 (UI ボタン / リレー /sync 共用): pull → add/commit → push を一括実行し、
// ユーザー向けの短い結果メッセージを返す。会話中の直接書き込み (予定メモ等) を
// 固定化を待たずに GitHub へ反映するための操作。
async function syncMemoryNow() {
  const notes = [];
  try {
    await gitMemory(['pull', '--ff-only']);
  } catch {
    notes.push('pull は見送り (オフラインか競合)');
  }
  try {
    await gitMemory(['add', '-A']);
    let committed = true;
    try {
      await gitMemory(['commit', '-m', `manual sync ${new Date().toISOString()}`]);
    } catch {
      committed = false; // 変更なし
    }
    await gitMemory(['push']);
    notes.unshift(committed ? '新しい記憶を月へ納めました' : '手元に新しい変更なし (同期確認済み)');
  } catch {
    notes.push('push 失敗 — 次回の同期で再送されます');
  }
  return `☾ ${notes.join(' / ')}`;
}

ipcMain.handle('navi:sync-memory', async () => await syncMemoryNow());

// ---- PC リレーサーバ (Android 版の入口、src/relay.js) ----
// config.relay.enabled = true のときだけ起動する (既定 false なので現運用に影響なし)。
// token が空なら初回に生成して保存する。chatBusy は isBusy/setBusy 経由で relay と共有し、
// PC 側チャット・リマインドと /ask が衝突しないようにする (使用中は 429)。
function startRelayIfEnabled() {
  if (!config.relay.enabled) return;
  if (!config.relay.token) {
    config.relay.token = randomUUID();
    saveConfig();
  }
  try {
    startRelay({
      port: config.relay.port,
      token: config.relay.token,
      ask,
      isBusy: () => chatBusy,
      setBusy: (v) => { chatBusy = !!v; },
      getName: () => themeName,
      version: localVersion(),
      memoryPath: MEMORY_PATH,
      sync: syncMemoryNow,
    });
  } catch (err) {
    console.log('[relay] start failed:', err?.message ?? err);
  }
}

// ---- タスクトレイ常駐 ----
// closeToTray 時の生存点。tray はモジュール変数に保持する (GC でアイコンが消えるのを防ぐ)。
let tray = null;

function toggleWindowVisible() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show(); // reload はしない — チャット履歴はそのまま残る
    win.focus();
  }
}

function updateTrayTooltip() {
  tray?.setToolTip(`NAVI.exe — ${themeName}`);
}

// トレイメニューは会議録音の状態 (録音中か否か) で項目が変わるため、
// テンプレートを関数で組み立てて録音開始/停止のたびに再構築する。
function buildTrayMenu() {
  const meetingItems = meetingActive()
    ? [{ label: '⏹ 拝聴を終了', click: () => sendMeetingControl({ action: 'stop' }) }]
    : [
        { label: '🎙 会議を拝聴 (日本語)', click: () => sendMeetingControl({ action: 'start', language: 'ja' }) },
        { label: '🎙 会議を拝聴 (English)', click: () => sendMeetingControl({ action: 'start', language: 'en' }) },
        { label: '🎙 会議を拝聴 (自動判定)', click: () => sendMeetingControl({ action: 'start', language: 'auto' }) },
        { label: '📝 直近の録音から議事録を作り直す', click: retryMinutesFromLatest },
      ];
  return Menu.buildFromTemplate([
    { label: '表示/隠す', click: toggleWindowVisible },
    {
      label: '☾ 記憶を同期',
      click: async () => {
        const msg = await syncMemoryNow();
        new Notification({
          title: `☾ ${themeName}`,
          body: msg.replace(/^☾\s*/, '').slice(0, 150),
        }).show();
      },
    },
    { type: 'separator' },
    ...meetingItems,
    { type: 'separator' },
    { label: '⛩ 記憶を固定化して終了', click: shutdownWithConsolidation },
  ]);
}

function updateTrayMenu() {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray() {
  // アイコン: 開発時は APP_ROOT/build/icon.ico、パッケージ時は resources 配下も探す
  const candidates = [
    path.join(APP_ROOT, 'build', 'icon.ico'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.ico'),
  ];
  const iconPath = candidates.find((p) => p && existsSync(p));
  try {
    tray = new Tray(iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty());
  } catch (err) {
    console.log('[tray] create failed:', err?.message ?? err); // トレイ無しでも起動は続行
    return;
  }
  updateTrayTooltip();
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', toggleWindowVisible);
}

// ---- 会議録音 (マイク + システム音声ループバック) ----
// 録音の実体は renderer/meeting.js (getUserMedia + getDisplayMedia + MediaRecorder)。
// main 側はループバック許可 (setDisplayMediaRequestHandler)・webm チャンクのファイル追記・
// トレイメニューからの開始/停止指示を担う。録音状態の正は renderer で、main は
// navi:meeting-start / navi:meeting-stop の受信時にのみ状態を切り替える
// (renderer 側でマイク取得に失敗した場合は start が届かず、トレイは待機表示のまま)。
// 開発時は リポ直下 recordings/ (.gitignore 済 — 公開リポへ混入させない)、
// パッケージ時は userData/recordings に保存する。
const RECORDINGS_DIR = path.join(DATA_ROOT, 'recordings');
let meetingStream = null; // 書き込み中の WriteStream (null = 録音していない)
let meetingFilePath = null;
let meetingLanguage = 'ja';

function meetingActive() {
  return meetingStream !== null;
}

// トレイ → renderer への開始/停止指示。録音開始時はウィンドウを出して
// LISTENING 表示 (renderer/meeting.js) が見えるようにする。
function sendMeetingControl(cmd) {
  if (!win) return;
  if (cmd.action === 'start' && !win.isVisible()) {
    win.show();
    win.focus();
  }
  win.webContents.send('navi:meeting-control', cmd);
}

function meetingFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `meeting_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.webm`;
}

ipcMain.on('navi:meeting-start', (event, info) => {
  if (meetingActive()) return; // 二重開始は無視 (renderer 側でもガード済み)
  try {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    meetingLanguage = ['ja', 'en', 'auto'].includes(info?.language) ? info.language : 'ja';
    meetingFilePath = path.join(RECORDINGS_DIR, meetingFileName());
    meetingStream = createWriteStream(meetingFilePath);
    meetingStream.on('error', (err) => {
      console.log('[meeting] write failed:', err?.message ?? err);
    });
    updateTrayMenu();
  } catch (err) {
    meetingStream = null;
    meetingFilePath = null;
    event.sender.send('navi:meeting-status', `録音ファイルを作成できませんでした: ${String(err?.message ?? err)}`);
  }
});

// 30秒ごとの webm チャンク (ArrayBuffer) を追記する
ipcMain.on('navi:meeting-chunk', (_e, chunk) => {
  if (!meetingStream) return;
  try { meetingStream.write(Buffer.from(chunk)); } catch { /* error イベント側でログ済み */ }
});

ipcMain.on('navi:meeting-stop', (_e, info) => {
  if (!meetingStream) return;
  const stream = meetingStream;
  const filePath = meetingFilePath;
  const language = ['ja', 'en', 'auto'].includes(info?.language) ? info.language : meetingLanguage;
  meetingStream = null;
  meetingFilePath = null;
  updateTrayMenu();
  stream.end(() => onMeetingRecorded(filePath, language));
});

// ---- 文字起こし → 議事録パイプライン ----
// 録音完了 (onMeetingRecorded) 後の流れ:
//   1. scripts/transcribe.py (faster-whisper) をバックグラウンド実行。chatBusy は持たない —
//      文字起こし中も会話・リマインドは並行できる。進捗は 60 秒おきに status 系で chat へ。
//   2. 完了した transcript (.txt) を ask() に渡し (chat が空くのを待って直列化)、
//      議事録を memory/minutes/ へ書かせる (fireReminder と同じ完走ストリーミング)。
// 録音 webm と txt は recordings/ に残す — トレイの「📝 直近の録音から議事録を作り直す」で再試行できる。
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3時間で打ち切り
let transcribing = false; // 文字起こしの多重起動ガード (議事録クエリ側は chatBusy で直列化)

function sendMeetingStatus(msg) {
  win?.webContents.send('navi:meeting-status', msg);
}

// 開発時はリポ直下 scripts/、パッケージ時は resources/scripts/ (asar 外) を探す
function transcribeScriptPath() {
  const candidates = [
    path.join(APP_ROOT, 'scripts', 'transcribe.py'),
    path.join(process.resourcesPath ?? '', 'scripts', 'transcribe.py'),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? candidates[0];
}

function transcriptPathFor(audioPath) {
  const ext = path.extname(audioPath);
  return path.join(path.dirname(audioPath), `${path.basename(audioPath, ext)}.txt`);
}

// 録音完了フック: 通知 → バックグラウンド文字起こし → 議事録クエリ
function onMeetingRecorded(filePath, language) {
  sendMeetingStatus('🎙 拝聴を終えました。文字起こしを始めます (数十分かかることがあります)…');
  startTranscription(filePath, language);
}

function startTranscription(filePath, language) {
  if (transcribing) {
    sendMeetingStatus('⚠ 別の文字起こしが進行中です。完了後にもう一度お試しください。');
    return;
  }
  transcribing = true;
  const txtPath = transcriptPathFor(filePath);
  const model = ['small', 'medium'].includes(config.meeting.model) ? config.meeting.model : 'small';
  const lang = ['ja', 'en', 'auto'].includes(language) ? language : 'auto';
  let child;
  try {
    child = spawn(
      'python',
      [transcribeScriptPath(), filePath, '--language', lang, '--model', model, '--out', txtPath],
      { windowsHide: true, timeout: TRANSCRIBE_TIMEOUT_MS, killSignal: 'SIGKILL' }
    );
  } catch (err) {
    transcribing = false;
    sendMeetingStatus(`⚠ 文字起こしを開始できませんでした: ${String(err?.message ?? err)}`);
    return;
  }
  const startedAt = Date.now();
  let stderrTail = ''; // 失敗時の報告用に末尾だけ保持
  let lastStatusAt = Date.now();
  child.stderr?.on('data', (buf) => {
    const text = String(buf);
    stderrTail = (stderrTail + text).slice(-1500);
    // transcribe.py の "progress: <処理済み>s / <全体>s" 行を 60 秒おきに chat へ流す
    const matches = text.match(/progress:\s*[\d.]+s\s*\/\s*[\d.]+s/g);
    if (matches && Date.now() - lastStatusAt >= 60000) {
      lastStatusAt = Date.now();
      const m = matches[matches.length - 1].match(/([\d.]+)s\s*\/\s*([\d.]+)s/);
      const pct = m ? Math.min(100, Math.round((parseFloat(m[1]) / Math.max(1, parseFloat(m[2]))) * 100)) : 0;
      sendMeetingStatus(`📝 文字起こし中… ${pct}% (${Math.round((Date.now() - startedAt) / 60000)}分経過)`);
    }
  });
  let settled = false; // 'error' と 'close' の二重処理ガード
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    transcribing = false;
    sendMeetingStatus(`⚠ ${msg}\n録音は ${filePath} に残っています。トレイの「📝 直近の録音から議事録を作り直す」で再試行できます。`);
    new Notification({ title: `📝 ${themeName} — 文字起こし失敗`, body: msg.slice(0, 150) }).show();
  };
  child.on('error', (err) =>
    fail(`文字起こしを開始できませんでした (python が見つからない可能性): ${String(err?.message ?? err)}`));
  child.on('close', (code, signal) => {
    if (settled) return;
    if (code === 0 && existsSync(txtPath)) {
      settled = true;
      transcribing = false;
      runMinutesQuery(txtPath, filePath); // 非同期 — chat の空きを待って議事録クエリを完走させる
    } else if (signal || Date.now() - startedAt >= TRANSCRIBE_TIMEOUT_MS) {
      fail('文字起こしが3時間のタイムアウトに達したため中断しました。');
    } else if (code === 0) {
      fail(`文字起こしは終了しましたが transcript が見つかりません: ${txtPath}`);
    } else {
      const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
      fail(`文字起こしが失敗しました (exit ${code}): ${tail}`);
    }
  });
}

// 議事録ファイル名のタイムスタンプ: 録音ファイル名 meeting_YYYY-MM-DD_HHmm.webm 由来を優先
function minutesStamp(webmPath) {
  const m = webmPath ? path.basename(webmPath).match(/(\d{4}-\d{2}-\d{2})_(\d{4})/) : null;
  if (m) return `${m[1]}_${m[2]}`;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function minutesPrompt(txtPath, webmPath) {
  const stamp = minutesStamp(webmPath);
  const fileName = `${stamp}_minutes.md`;
  const outPath = path.join(MEMORY_DIR, 'minutes', fileName).replace(/\\/g, '/');
  const txt = path.resolve(txtPath).replace(/\\/g, '/');
  return `[議事録作成] 会議の文字起こし ${txt} を Read して議事録を作成し、${outPath} に Write せよ (memory/minutes/ は書込可領域)。
構成: 日時 / 出席 (判別できる範囲) / 議題 / 議論の要点 / 決定事項 / 宿題 (担当と期限) / 次回。
言語: 会議の主要言語に合わせる。英語会議なら英語で作成し、冒頭に日本語3行の要約を付ける。
記憶索引 NAVI_MEMORY.md の「記憶の索引」に1行 (- [議事録 ${stamp.slice(0, 10)}](minutes/${fileName}) — 会議の一言要約) を追加せよ。
完了後、チャットには決定事項と宿題だけを4〜6行で報告せよ。`;
}

// chat の空きを待つ (ユーザー会話・リマインドと ask() を直列化する)
async function waitForChatIdle(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (!quitting) {
    if (win && !chatBusy) return true; // 直後に呼び出し側が同期的に chatBusy を立てる
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return false;
}

// 議事録クエリ: fireReminder と同様に ask() を完走させ chunk を renderer へ流す
async function runMinutesQuery(txtPath, webmPath) {
  if (!(await waitForChatIdle(30 * 60 * 1000))) {
    sendMeetingStatus(`⚠ チャットが空かないため議事録作成を見送りました。transcript は ${txtPath} にあります。トレイの「📝 直近の録音から議事録を作り直す」で再実行できます。`);
    return;
  }
  chatBusy = true;
  try {
    try { mkdirSync(path.join(MEMORY_DIR, 'minutes'), { recursive: true }); } catch { /* Write 側でも作成される */ }
    win.webContents.send('navi:minutes-start');
    let full = '';
    for await (const chunk of ask(minutesPrompt(txtPath, webmPath))) {
      full += (full ? '\n' : '') + chunk;
      win.webContents.send('navi:chunk', chunk);
    }
    win.webContents.send('navi:done');
    speakReply(full); // 読み上げ (VOICEVOX、エンジン未稼働なら無音)
    new Notification({
      title: `📝 ${themeName} — 議事録`,
      body: (full || '議事録を作成いたしました。').slice(0, 150),
    }).show();
  } catch (err) {
    win?.webContents.send('navi:error', String(err?.message ?? err));
  }
  chatBusy = false;
}

// トレイ「📝 直近の録音から議事録を作り直す」: 最新の recordings/*.webm に対して
// 文字起こし→議事録を再実行する。txt が既にあれば文字起こしをスキップして議事録のみ。
function latestRecording() {
  try {
    const files = readdirSync(RECORDINGS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.webm'))
      .map((f) => path.join(RECORDINGS_DIR, f));
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

function retryMinutesFromLatest() {
  if (meetingActive()) {
    sendMeetingStatus('⚠ 録音中です。「⏹ 拝聴を終了」の後に自動で議事録を作成します。');
    return;
  }
  if (transcribing) {
    sendMeetingStatus('⚠ 文字起こしが進行中です。完了をお待ちください。');
    return;
  }
  const webm = latestRecording();
  if (!webm) {
    sendMeetingStatus('⚠ recordings/ に録音が見つかりません。');
    return;
  }
  if (win && !win.isVisible()) {
    win.show();
    win.focus();
  }
  const txtPath = transcriptPathFor(webm);
  if (existsSync(txtPath)) {
    sendMeetingStatus(`📝 既存の文字起こしから議事録を作り直します: ${path.basename(txtPath)}`);
    runMinutesQuery(txtPath, webm);
  } else {
    sendMeetingStatus(`🎙 ${path.basename(webm)} の文字起こしを始めます (数十分かかることがあります)…`);
    startTranscription(webm, 'auto');
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('NAVI.exe'); // Windows 通知の表示名
  // レンダラのマイク利用 (getUserMedia) を許可する (音声入力用)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  // 会議録音用: getDisplayMedia にシステム音声のループバックを許可する。
  // Electron の仕様で video ソースの指定が必須のため先頭画面を渡すが、
  // renderer (meeting.js) は video トラックを取得直後に stop して音声だけ使う。
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources.length) callback({ video: sources[0], audio: 'loopback' });
        else callback({}); // 画面ソースが取れなければ拒否 (renderer 側でエラー表示)
      })
      .catch(() => callback({}));
  });
  probeVoiceCultures(); // 音声認識エンジンの有無を起動時に1回プローブ
  createWindow();
  createTray(); // タスクトレイ常駐 (表示切替・同期・固定化して終了)
  checkForUpdate(); // 非同期 (オフライン時は静かに諦める)
  syncMemoryPull(); // 非同期 (失敗しても起動を妨げない)
  startRelayIfEnabled(); // 既定は無効 (config.relay.enabled)
  autoStartVoiceEngine(); // 非同期 — VOICEVOX 未稼働なら自動起動を試み、成功で 🔊 を活性化
});

// ---- 起動時バージョン確認 ----
// 公開リポの version.json と package.json の version を比較し、
// 新しければ renderer へ navi:update-available を通知する。
const VERSION_URL = 'https://raw.githubusercontent.com/Shotaro-Tada/navi/main/version.json';

function localVersion() {
  try {
    return JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// 単純な semver 比較: "1.2.3" を数値分解して remote > local なら true
function isNewerVersion(remote, local) {
  const r = String(remote).split('.').map((n) => parseInt(n, 10) || 0);
  const l = String(local).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0);
  }
  return false;
}

async function checkForUpdate() {
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const remote = await res.json();
    if (!remote?.version || !isNewerVersion(remote.version, localVersion())) return;
    const payload = {
      version: String(remote.version),
      notes: String(remote.notes ?? ''),
      url: String(remote.windows ?? ''),
    };
    const send = () => win?.webContents.send('navi:update-available', payload);
    if (!win) return;
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  } catch { /* オフライン・タイムアウト時は無視 */ }
}

app.on('window-all-closed', () => {
  if (!quitting) app.quit();
});

// ---- IPC ----
// × ボタン (renderer の #btn-close): closeToTray 有効時はトレイへ隠すだけ。
// 無効時は従来どおり記憶を固定化して終了する。
ipcMain.on('navi:close', () => {
  if (config.tray.closeToTray) win?.hide();
  else shutdownWithConsolidation();
});
ipcMain.on('navi:minimize', () => win?.minimize());

// チャット内リンクを既定ブラウザで開く (https?: のみ許可)
ipcMain.on('navi:open-external', (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch { /* 不正な URL は無視 */ }
});
ipcMain.handle('navi:consolidate', async () => {
  const result = await consolidateMemory();
  syncMemoryPush(); // 完了直後に非同期で push (失敗は無視)
  return result;
});
ipcMain.handle('navi:profile', () => getProfile());
ipcMain.handle('navi:get-config', () => config);
ipcMain.handle('navi:get-theme', () =>
  theme ? { name: theme.name, char: theme.char, bg: theme.bg } : null
);

// Claude Code サブスクリプション認証の有無 (チュートリアル Step1 用)
ipcMain.handle('navi:check-auth', () => {
  try {
    return existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
  } catch {
    return false;
  }
});

// 記憶索引の「- 名前: ...」行をテーマの表示名へ置換する (アプリUIと人格が読む行)
function renameMemoryIndex(newName) {
  if (!newName) return;
  try {
    if (getProfile().name === newName) return; // 同名なら記憶には触れない
    const txt = readFileSync(MEMORY_PATH, 'utf8');
    const updated = txt.replace(
      /^(-\s*名前[:：]\s*).*$/m,
      (_m, head) => `${head}${newName}（テーマ選択により改名、${todayStr()}）`
    );
    if (updated !== txt) writeFileSync(MEMORY_PATH, updated);
  } catch { /* 記憶索引が無ければ何もしない */ }
}

// チュートリアル完了時の一括適用: 言語 + テーマ + tutorialDone
ipcMain.handle('navi:apply-setup', (_e, setup) => {
  config.language = setup?.language === 'en' ? 'en' : 'ja';
  setLanguage(config.language);
  config.tutorialDone = true;

  const themeId = setup?.theme;
  if (themeId) {
    try {
      const next = readThemeFile(themeId); // 不正IDはここで throw
      config.theme = String(themeId);
      theme = next;
      themeName = next?.name || themeName;
      updateTrayTooltip();
      if (next?.personaCharacter) setPersonaCharacter(next.personaCharacter);
      renameMemoryIndex(next?.name);
      resetSession(); // 人格が変わるので次の ask から新規セッション
    } catch { /* 読めないテーマは無視して現テーマを維持 */ }
  }
  saveConfig();
  win?.reload();
  return true;
});

// ドット絵テーマの自動生成 (✎ ボタン / renderer/generator.js)
// 成功時はそのままテーマを適用して画面を読み直す (apply-setup と同じ適用手順)。
ipcMain.handle('navi:generate-theme', async (_e, description) => {
  if (chatBusy) return { ok: false, error: '別の処理が進行中です。完了後にお試しください。' };
  chatBusy = true;
  try {
    const savedPath = await generateTheme(String(description ?? ''));
    if (!savedPath) {
      return { ok: false, error: 'テーマを描き起こせませんでした。説明を変えてもう一度お試しください。' };
    }
    const id = path.basename(path.dirname(savedPath)); // themes/custom_<ts>/theme.json → custom_<ts>
    const next = readThemeFile(id);
    config.theme = id;
    theme = next;
    themeName = next?.name || themeName;
    updateTrayTooltip();
    if (next?.personaCharacter) setPersonaCharacter(next.personaCharacter);
    renameMemoryIndex(next?.name);
    resetSession(); // 人格が変わるので次の ask から新規セッション
    saveConfig();
    win?.reload();
    return { ok: true, id, name: next?.name ?? '' };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    chatBusy = false;
  }
});

ipcMain.handle('navi:inspire', async () => {
  if (chatBusy) return null;
  chatBusy = true;
  try {
    return await inspire();
  } catch {
    return null;
  } finally {
    chatBusy = false;
  }
});

ipcMain.on('navi:set-model', (_e, tier) => {
  if (['sonnet', 'opus', 'fable'].includes(tier)) {
    config.model = tier;
    setModelTier(tier);
    saveConfig();
  }
});

ipcMain.on('navi:ask', async (event, text) => {
  chatBusy = true;
  try {
    let full = '';
    for await (const chunk of ask(text)) {
      full += (full ? '\n' : '') + chunk;
      event.sender.send('navi:chunk', chunk);
    }
    event.sender.send('navi:done');
    speakReply(full, event.sender); // 非同期 — 合成を待たずに次の入力を受け付ける
  } catch (err) {
    event.sender.send('navi:error', String(err?.message ?? err));
  }
  chatBusy = false;
});

// ---- 読み上げ (VOICEVOX 連携、PC 版のみ — src/tts.js) ----
// 応答全文を WAV に合成して renderer (navi:speak-wav) へ送る。エンジン不達時は
// speak() が null を返すだけなので、音声なしの通常動作に自然に戻る。
function speakReply(text, sender) {
  if (!config.voice.enabled || quitting || !text) return;
  speak(text, config.voice)
    .then((wav) => {
      if (!wav || quitting) return;
      (sender ?? win?.webContents)?.send('navi:speak-wav', Buffer.from(wav));
    })
    .catch(() => { /* 音声は補助機能 — 失敗しても会話は成立する */ });
}

// エンジン稼働可否 (renderer が 🔊 ボタンの表示判定に使う)
ipcMain.handle('navi:voice-tts-available', async () => await isTtsAvailable());

// ---- VOICEVOX エンジン自動起動 (whenReady から非同期で呼ぶ) ----
// 読み上げ有効でエンジン不達なら run.exe を探して起動を試みる (src/tts.js)。
// 稼働に至ったら renderer へ通知して 🔊 を活性化する。見つからない・起動失敗は
// 静かに無効のまま (音声なしの通常動作 — speakReply は null を受けて無音になる)。
async function autoStartVoiceEngine() {
  if (!config.voice.enabled) return;
  try {
    if (await isTtsAvailable()) return; // 既に稼働中 — renderer 起動時の判定で 🔊 は出る
    if (!(await ensureEngineRunning(config.voice))) return;
    const send = () => win?.webContents.send('navi:voice-availability', { available: true });
    if (!win) return;
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  } catch { /* 音声は補助機能 — 失敗しても起動を妨げない */ }
}

// 🔊 トグルの永続化 (renderer の #btn-voice)
ipcMain.on('navi:set-voice', (_e, enabled) => {
  config.voice.enabled = !!enabled;
  saveConfig();
});

// ---- 音声入力 (Windows SAPI / System.Speech) ----
const PS_EXEC = 'powershell';
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];

function voiceCulture() {
  return config.language === 'en' ? 'en-US' : 'ja-JP';
}

// インストール済み音声認識エンジンの culture 一覧 (起動時に1回だけ実行し、以後はキャッシュ)
let voiceCulturesPromise = null;
function probeVoiceCultures() {
  voiceCulturesPromise ??= new Promise((resolve) => {
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }';
    execFile(PS_EXEC, [...PS_FLAGS, script], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
  return voiceCulturesPromise;
}

// 内蔵認識エンジンが無い言語向け: Windows 標準の音声入力 (Win+H) をキー送出で起動
ipcMain.handle('navi:voice-fallback', () => {
  const psSrc = `Add-Type @"
using System;using System.Runtime.InteropServices;
public class KB{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);}
"@
[KB]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);[KB]::keybd_event(0x48,0,0,[UIntPtr]::Zero);[KB]::keybd_event(0x48,0,2,[UIntPtr]::Zero);[KB]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
  const encoded = Buffer.from(psSrc, 'utf16le').toString('base64');
  execFile('powershell', ['-NoProfile', '-EncodedCommand', encoded], () => { /* 失敗しても無害 */ });
  return true;
});

ipcMain.handle('navi:voice-available', async () =>
  (await probeVoiceCultures()).includes(voiceCulture())
);

// PowerShell 単一引用符リテラル用のエスケープ
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// WAV (ArrayBuffer) を %TEMP% に書き、System.Speech の DictationGrammar で文字起こしする
ipcMain.handle('navi:transcribe', async (_e, wav) => {
  const wavPath = path.join(os.tmpdir(), `navi-voice-${Date.now()}.wav`);
  writeFileSync(wavPath, Buffer.from(wav));
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    `$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo ${psQuote(voiceCulture())})`,
    '$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    `$rec.SetInputToWaveFile(${psQuote(wavPath)})`,
    '$parts = @()',
    'while ($true) { $r = $rec.Recognize(); if ($null -eq $r) { break }; if ($r.Text) { $parts += $r.Text } }',
    '$rec.Dispose()',
    "[Console]::Out.Write(($parts -join ' '))",
  ].join('; ');
  try {
    return await new Promise((resolve, reject) => {
      execFile(
        PS_EXEC,
        [...PS_FLAGS, script],
        { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(err.killed
              ? '音声認識がタイムアウトしました (15秒)'
              : String(stderr || err.message).trim().slice(0, 300)));
          } else {
            resolve(String(stdout).trim());
          }
        }
      );
    });
  } finally {
    try { unlinkSync(wavPath); } catch { /* 一時ファイルの削除失敗は無視 */ }
  }
});

// ---- スケジューラ (定時リマインド) ----
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function reminderPrompt() {
  return `[定時リマインド] 今日は ${todayStr()} です。あなたの記憶のスケジュール (mem_schedule.md など) を確認し、今日の予定と直近に迫っている予定をショウタロウ様へ簡潔に案内してください。該当する予定が無ければ「本日のご予定は特にございません」と一言だけ添えてください。`;
}

async function fireReminder() {
  if (!win || chatBusy) return;
  chatBusy = true;
  try {
    win.webContents.send('navi:reminder-start');
    let full = '';
    for await (const chunk of ask(reminderPrompt())) {
      full += (full ? '\n' : '') + chunk;
      win.webContents.send('navi:chunk', chunk);
    }
    win.webContents.send('navi:done');
    speakReply(full); // 読み上げ (VOICEVOX、エンジン未稼働なら無音)
    new Notification({
      title: `⛩ ${themeName}からのお知らせ`,
      body: (full || '本日の予定をご確認ください。').slice(0, 150),
    }).show();
  } catch (err) {
    win.webContents.send('navi:error', String(err?.message ?? err));
  }
  chatBusy = false;
}

function checkReminder() {
  if (quitting || chatBusy || !win) return;
  if (!config.reminder.enabled) return;
  if (nowHHMM() >= config.reminder.time && config.reminder.lastFired !== todayStr()) {
    config.reminder.lastFired = todayStr();
    saveConfig();
    fireReminder();
  }
}

// ---- 定例ミーティング連動の拝聴提案 (config.meeting.suggest) ----
// checkReminder と同じ30秒間隔のチェックで、該当曜日の該当時刻に1回だけ
// チャット通知 + Notification を出す。録音の自動開始はしない (同意マナーのため、
// 必ず人がトレイの 🎙 から開始する)。重複防止は日付キーの Set (再起動でリセットされるが、
// 発火窓が時刻+5分以内なので再通知は窓内の再起動時のみ — 実害なし)。
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const meetingSuggestFired = new Set(); // "YYYY-MM-DD|<index>"
function checkMeetingSuggest() {
  if (quitting || !win) return;
  const list = Array.isArray(config.meeting.suggest) ? config.meeting.suggest : [];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  list.forEach((item, idx) => {
    const t = hhmmToMin(item?.time);
    if (t === null || now.getDay() !== Number(item?.day)) return;
    if (nowMin < t || nowMin > t + 5) return; // 該当時刻から5分以内のみ (スリープ明けの遅延発火を防ぐ)
    const key = `${todayStr()}|${idx}`;
    if (meetingSuggestFired.has(key)) return; // 日付で重複防止 (同日1回だけ)
    meetingSuggestFired.add(key);
    const label = String(item?.label ?? '定例ミーティング');
    const body = `まもなく ${label} です。拝聴いたしますか? (トレイの 🎙 から開始できます)`;
    sendMeetingStatus(`🎙 ${body}`); // チャットへは meeting-status チャネルで表示 (meeting.js が addMsg)
    new Notification({ title: `🎙 ${themeName} — 定例のご案内`, body }).show();
  });
}

// 起動15秒後に初回チェック (起動がリマインド時刻より後ならその場で案内)、以後30秒間隔
setTimeout(checkReminder, 15000);
setInterval(checkReminder, 30000);
setTimeout(checkMeetingSuggest, 15000);
setInterval(checkMeetingSuggest, 30000);

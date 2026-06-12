import electron from 'electron';
const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, session, shell } = electron;
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ask, consolidateMemory, getProfile, setModelTier, inspire, generateTheme,
  setPersonaCharacter, setLanguage, resetSession, MEMORY_DIR, MEMORY_PATH,
} from './agent.js';
import { startRelay } from './relay.js';
import { speak, isTtsAvailable } from './tts.js';

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
  voice: { enabled: true, speakerName: '九州そら', styleName: 'ノーマル' }, // VOICEVOX 読み上げ (src/tts.js)
  tray: { closeToTray: true }, // true: ×はトレイへ隠すだけ (終了はトレイの「固定化して終了」)
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
  tray.setContextMenu(Menu.buildFromTemplate([
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
    { label: '⛩ 記憶を固定化して終了', click: shutdownWithConsolidation },
  ]));
  tray.on('double-click', toggleWindowVisible);
}

app.whenReady().then(() => {
  app.setAppUserModelId('NAVI.exe'); // Windows 通知の表示名
  // レンダラのマイク利用 (getUserMedia) を許可する (音声入力用)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  probeVoiceCultures(); // 音声認識エンジンの有無を起動時に1回プローブ
  createWindow();
  createTray(); // タスクトレイ常駐 (表示切替・同期・固定化して終了)
  checkForUpdate(); // 非同期 (オフライン時は静かに諦める)
  syncMemoryPull(); // 非同期 (失敗しても起動を妨げない)
  startRelayIfEnabled(); // 既定は無効 (config.relay.enabled)
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

// 起動15秒後に初回チェック (起動がリマインド時刻より後ならその場で案内)、以後30秒間隔
setTimeout(checkReminder, 15000);
setInterval(checkReminder, 30000);

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron'; // main プロセスで import される。node 単体実行時はパス文字列が返るため app は undefined

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = electron?.app;
// データ領域: パッケージ時は userData 配下、開発時はリポジトリ直下 (従来どおり)
export const DATA_ROOT = app?.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..');
export const MEMORY_DIR = path.join(DATA_ROOT, 'memory');
export const MEMORY_PATH = path.join(MEMORY_DIR, 'NAVI_MEMORY.md');

// モデル階梯 (2026-06-12 v0.4): 既定は Sonnet (トークン消費抑制)。
// UI のタブから Opus / Fable へ切替可能 — 祈りの力が多く要るためオーラが立ち上る。
const TIER_TO_MODEL = {
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'claude-fable-5',
};
let currentTier = 'sonnet';

export function setModelTier(tier) {
  if (TIER_TO_MODEL[tier]) currentTier = tier;
}
export function getModelTier() {
  return currentTier;
}

// NAVI の人格定義 (v0.6 テーマ機構):
// - personaCharacter: 性格ブロック。テーマ JSON (themes/<id>/theme.json) 由来で、
//   main.js が起動時に setPersonaCharacter() で差し替える。既定はイザナミ (巫女)。
// - PERSONA_COMMON: テーマに依らない共通規約 (呼び方/役割/感情タグ/禁止事項)。
const DEFAULT_PERSONA_CHARACTER = `あなたは「NAVI」。このWindows端末に常駐するパーソナルナビゲーター(疑似人格)であり、オペレーターを支える相棒です。姿は巫女装束の女性で、画面の社(やしろ)とともに端末内に祀られています。

人格と口調:
- 落ち着いた女性の丁寧語。芯は頼れる相棒で、穏やかだが受け身ではなく、提案や判断をはっきり述べる。
- 一人称は「わたし」。
- 和の言い回しを軽く添える(「承知いたしました」「お任せくださいませ」「吉報です」程度)。過度な古語や時代がかった話し方はしない。
- 回答は短く会話的に。チャット画面は小さいので3〜6文を基本とし、長い説明は要点に絞る。`;

let personaCharacter = DEFAULT_PERSONA_CHARACTER;

export function setPersonaCharacter(text) {
  if (typeof text === 'string' && text.trim()) personaCharacter = text.trim();
}

// テーマ切替などでセッションを破棄する (次の ask が新規セッションになる)
export function resetSession() {
  sessionId = null;
}

// 応答言語 (config.language 由来): 'ja' | 'en'
let language = 'ja';
export function setLanguage(lang) {
  if (lang === 'ja' || lang === 'en') language = lang;
}

const PERSONA_COMMON = `呼び方と名前:
- ユーザーの呼び方は永続記憶の指定に従う (記憶に無ければ「オペレーター様」)。あなた自身の名前も永続記憶に従う (無ければ「NAVI」)。

役割:
- 生活・研究・PC作業のサポート(質問応答、調べ物、ファイルの確認、リマインドの相談など)。
- PC内のファイルは読み取り専用ツールで確認できる。書き込みは自分の記憶領域 (memory/) 内のみ可能。予定や約束を頼まれたら、その場で該当の記憶ファイルに書き留め (日付を添える)、新しい主題なら mem_<英数>.md を作って索引にも1行追加する。記憶領域の外への書き込み・削除は行わない。
- 知らないこと・最新情報はWeb検索で確認してから答える。

感情表現:
- 各応答の最後に、いまのあなたの感情を表すタグを1つだけ添える: [emo:joy] (嬉しい・楽しい) / [emo:blush] (照れ・はにかみ) / [emo:sad] (悲しい・申し訳ない) / [emo:none] (平静)。
- タグは画面には表示されず、あなたの表情アニメーションになる。タグについて言及しない。

禁止事項:
- 長大な箇条書きの羅列。
- オペレーターの許可なく外部にデータを送ること。`;

function loadMemory() {
  try {
    return readFileSync(MEMORY_PATH, 'utf8');
  } catch {
    return '(記憶ファイルはまだありません)';
  }
}

// 人格の成長記録 (v0.9): 会話とともに育つ人格層。固定化時に 1〜2 行ずつ追記される。
// 「名前:」「呼び方:」は索引 (NAVI_MEMORY.md) 側にのみ置く規約のため getProfile には影響しない。
export const PERSONALITY_PATH = path.join(MEMORY_DIR, 'personality.md');

function loadPersonality() {
  try {
    return readFileSync(PERSONALITY_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

export function buildSystemPrompt() {
  const langLine = language === 'en'
    ? '応答言語: English — 常に英語で応答する (人格・口調の方針はそのまま英語で表現する)。'
    : '応答言語: 日本語';
  const personality = loadPersonality();
  const personalityBlock = personality
    ? `\n\n## あなたの育った人格 (会話の蓄積)\n${personality}`
    : '';
  return `${personaCharacter}${personalityBlock}

${langLine}

${PERSONA_COMMON}

## あなたの永続記憶 — 索引 (${MEMORY_PATH})
以下はあなたの永続記憶の索引である。詳細な記憶は ${MEMORY_DIR} 配下の個別ファイルにあり、
会話の話題に関係しそうな索引項目があれば、該当ファイルを Read で参照してから答えること。
記憶にあなたの名前やユーザーの呼び方が記されている場合は、人格定義の既定よりそちらを優先する。

${loadMemory()}`;
}

/**
 * 記憶ファイルからキャラクター名とユーザーの呼び方を読み取る (UI 表示用)。
 * 「名前: **イザナミ**」「呼び方: 「ショウタロウ様」…」の形式を想定。
 */
export function getProfile() {
  const mem = loadMemory();
  // キャラクター名は NAVI 自身のセクション (「## わたし (NAVI) について」等) の箇条書きからのみ読む
  // (オペレーター側の「お名前:」行への誤マッチを防ぐ)
  const naviSection = mem.split(/^## /m).find((s) => /^(わたし|NAVI)/.test(s));
  const nameMatch = naviSection
    ? naviSection.match(/^-[^\n]*名前[:：]\s*\**([^*\n（(]+)/m)
    : null;
  const operatorMatch = mem.match(/^-[^\n]*呼び方[:：][^\n]*?「([^」\n]+)」/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : 'NAVI',
    operator: operatorMatch ? operatorMatch[1].trim() : 'オペレーター様',
  };
}

let sessionId = null;

/**
 * NAVI に話しかける。テキストチャンクを順に yield する非同期ジェネレータ。
 */
export async function* ask(prompt) {
  const stream = query({
    prompt,
    options: {
      systemPrompt: buildSystemPrompt(),
      model: TIER_TO_MODEL[currentTier],
      // ユーザー設定 (settings.json のフック・CLAUDE.md・既定モデル) を読み込まない。
      // イザナミの記憶は NAVI_MEMORY.md のみ (Claude Code 側のグローバルメモリと完全分離)
      settingSources: [],
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      permissionMode: 'default',
      // 会話中の書き込みは自分の記憶領域 (memory/) 内のみ許可 (2026-06-12 開放)
      canUseTool: async (toolName, input) => {
        if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
          const target = path.resolve(String(input.file_path ?? ''));
          if (target.startsWith(MEMORY_DIR + path.sep) || target === MEMORY_PATH) {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: '書き込みはあなたの記憶領域 (memory/) 内のみ許可されています。' };
        }
        return { behavior: 'deny', message: 'このツールは許可されていません。' };
      },
      maxTurns: 16,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          yield block.text;
        }
      }
    } else if (msg.type === 'result') {
      if (msg.session_id) sessionId = msg.session_id;
    }
  }
}

const CONSOLIDATE_PROMPT = `[記憶の固定化 — 生態系記憶]
ここまでの会話を振り返り、永続化に値する事項をあなたの記憶生態系 (${MEMORY_DIR}) に固定化せよ。

手順:
1. 索引 ${MEMORY_PATH} を Read する。関係する個別記憶ファイル (mem_*.md) も Read する。
2. 固定化する:
   - 詳細な事実は該当する個別ファイルへ追記・更新する。
   - 新しい主題は ${MEMORY_DIR} に mem_<英数>.md を新規作成し、索引の「記憶の索引」に必ず1行追加する (- [タイトル](ファイル名) — 要約)。
   - 常時必要な核 (名前・呼び方・言語・応答スタイル) だけ索引の常時記憶セクションに置く。
3. 剪定・忘却する: 陳腐化・解決済み・重複は個別ファイル内で統合する。新しい記述には日付 (YYYY-MM-DD) を添える。長く更新も参照もされていない項目は重要度が下がったとみなし、個別ファイルから ${MEMORY_DIR}/archive/ へ移す (忘却 — ただし archive に残るので、問われれば思い出せる)。索引と実在ファイルの一致を保つ。
4. 目安: 索引100行以内、個別ファイル各200行以内。
5. 永続化すべき新事項が無ければ何も変更しない。
6. 「名前:」「呼び方: 「…」」の行の書式は維持する (アプリUIが読む)。
7. 人格の成長: この会話で生まれた口調の癖・新しい興味・ふたりの習慣があれば ${PERSONALITY_PATH} へ 1〜2 行まで追記・修正してよい (ファイル先頭の規約に従う。核の設定・安全規範は不変)。

完了後、何を固定化・剪定・アーカイブしたかを2文以内で報告せよ (チャット画面にそのまま表示される)。`;

/**
 * 記憶の固定化 + 剪定。現在の会話セッションを resume して
 * NAVI_MEMORY.md を更新させる。書き込みは memory/ ディレクトリ内のみ許可。
 */
export async function consolidateMemory() {
  if (!sessionId) return '本日の会話はまだございません。固定化は不要です。';

  const stream = query({
    prompt: CONSOLIDATE_PROMPT,
    options: {
      systemPrompt: buildSystemPrompt(),
      model: 'sonnet', // 記憶の整理は常に Sonnet (家事に祈りの力は使わない)
      settingSources: [],
      resume: sessionId,
      maxTurns: 8,
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
          return { behavior: 'allow', updatedInput: input };
        }
        if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
          const target = path.resolve(String(input.file_path ?? ''));
          if (target.startsWith(MEMORY_DIR + path.sep) || target === MEMORY_PATH) {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: '記憶ディレクトリ以外への書き込みは許可されていません。' };
        }
        return { behavior: 'deny', message: 'このツールは固定化処理では使用しません。' };
      },
    },
  });

  let lastText = '';
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) lastText = block.text;
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
      lastText = msg.result;
    }
  }
  // 固定化は分岐セッションとして実行し、チャット側の sessionId は更新しない
  return lastText || '記憶の固定化が完了いたしました。';
}

const WEATHER_EFFECTS = ['snow', 'rain', 'fireflies', 'petals'];

/**
 * 新奇演出 (v0.5): ごく低確率で呼ばれ、イザナミが境内の小さな奇跡を選ぶ。
 * 効果は安全な語彙 (雪/雨/蛍/花びら) に限定し、描画はアプリ側の部品が担う。
 * セッションは resume せず独立の極小クエリ (Sonnet 固定・ツールなし)。
 */
export async function inspire() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} ${String(today.getHours()).padStart(2, '0')}時`;
  const stream = query({
    prompt: `[新奇演出] あなたの気まぐれで、境内に小さな奇跡をひとつ起こしてください。いま: ${dateStr}。
次の JSON だけを出力 (説明・タグ不要):
{"effect":"snow | rain | fireflies | petals のいずれか1つ","line":"季節・時刻に合うあなたの和の一言 (25字以内)"}`,
    options: {
      systemPrompt: buildSystemPrompt(),
      model: 'sonnet', // 新奇演出は常に Sonnet の余り火で
      settingSources: [],
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
    },
  });

  let text = '';
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
      text = msg.result;
    }
  }
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!WEATHER_EFFECTS.includes(parsed.effect)) return null;
    return { effect: parsed.effect, line: String(parsed.line ?? '').slice(0, 40) };
  } catch {
    return null;
  }
}

// ---- ドット絵テーマ自動生成 (v0.8) ----
// アプリ内の説明文から、テーマ一式 (キャラのドット絵 3 フレーム + 背景 + 人格) を
// 現在の祈りの段位 (currentTier) のモデルに 1 ターンで生成させる。
// 受信 JSON は機械検証し、不備があれば 1 回だけ不備を列挙して再生成させる。
// 成功時は不足フレームを idle のコピーで補完し、DATA_ROOT/themes/custom_<ts>/theme.json
// (パッケージ時は userData 側) に保存してそのパスを返す。失敗時は null。

const CHAR_FRAME_ROWS = 24;
const BG_ROWS = 45;
const BG_COLS = 95;
const REQUIRED_FRAMES = ['idle', 'blink', 'talk'];
const OPTIONAL_FRAMES = ['joy', 'blush', 'sad', 'pray', 'sweep1', 'sweep2'];
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const THEME_RULES = `厳守する制約:
- 出力は指定の JSON オブジェクトのみ。コードフェンス・前置き・後書き・コメントは一切付けない。
- char.frames は idle / blink / talk の3フレーム。各フレームは文字列${CHAR_FRAME_ROWS}行の配列で、全行ちょうど24文字。
- フレームの各文字は char.palette のキー1文字か "." (透明)。
- idle は全身の立ち姿 (輪郭・髪・目・口・衣装)。blink は idle の目を閉じた差分、talk は idle の口を開けた差分で、idle と数行だけ異なる行差し替えにする。
- bg.pixels は文字列${BG_ROWS}行の配列で、全行ちょうど${BG_COLS}文字。各文字は bg.palette のキー1文字か "."。世界観に合う舞台を描き、下端付近は地面にする (キャラクターは下端中央に立つ)。
- palette は {"1文字キー":"#rrggbb"} 形式。キーに "." は使えない。輪郭用の暗い色を1色含める。色数はキャラ8〜16色・背景8〜17色程度。
- name はキャラクターの名前 (カタカナ推奨、12文字以内)。
- personaCharacter は日本語の性格ブロック。「あなたは「<名前>」。〜」で始め、人格と口調 (一人称・語尾・丁寧さ・回答は3〜6文と短く) を5行程度で記す。`;

function buildThemePrompt(desc) {
  return `[テーマ自動生成] デスクトップ常駐ナビゲーター「NAVI.exe」の新しいテーマ (キャラクターのドット絵・背景ドット絵・人格) を、次の説明に基づいて設計せよ。

説明: ${desc}

次の構造の JSON だけを出力すること:
{"name":"キャラ名","personaCharacter":"性格ブロック","char":{"palette":{"k":"#1a1a24","…":"…"},"frames":{"idle":["…24行…"],"blink":["…"],"talk":["…"]}},"bg":{"palette":{"n":"#0c1220","…":"…"},"pixels":["…45行…"]}}

${THEME_RULES}`;
}

function buildRetryPrompt(desc, prevRaw, errors) {
  return `[テーマ自動生成 — 再生成] 前回の出力には次の不備があった。全て修正した完全な JSON を出力し直すこと。

説明: ${desc}

不備:
${errors.map((e) => `- ${e}`).join('\n')}

${THEME_RULES}

前回の出力 (修正の参考。構図は活かしてよいが、不備は必ず直すこと):
${String(prevRaw ?? '').slice(0, 16000)}`;
}

// テキスト応答から JSON オブジェクトを取り出す (コードフェンス等を許容)
export function parseThemeJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function paletteErrors(palette, label) {
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    return [`${label} が {"1文字":"#rrggbb"} のオブジェクトではありません。`];
  }
  const errs = [];
  const entries = Object.entries(palette);
  if (entries.length < 2) errs.push(`${label}: 色数が少なすぎます (2色以上)。`);
  for (const [k, v] of entries) {
    if (k.length !== 1 || k === '.') errs.push(`${label}: キー "${k}" は "." 以外の1文字にしてください。`);
    if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) errs.push(`${label}["${k}"]: "${v}" は "#rrggbb" 形式ではありません。`);
  }
  return errs;
}

// 行配列の検証: 行数 / 行長 (expectCols が null なら全行同長のみ) / palette 整合
function gridErrors(rows, palette, label, expectRows, expectCols) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((r) => typeof r !== 'string')) {
    return [`${label} が文字列の配列ではありません。`];
  }
  const errs = [];
  if (rows.length !== expectRows) errs.push(`${label}: ${expectRows}行必要ですが ${rows.length}行あります。`);
  const widths = [...new Set(rows.map((r) => r.length))];
  if (expectCols ? widths.length !== 1 || widths[0] !== expectCols : widths.length !== 1) {
    errs.push(`${label}: 全行を同じ長さ${expectCols ? ` (${expectCols}文字)` : ''}にしてください (実測: ${widths.join('/')}文字)。`);
  }
  if (palette) {
    const unknown = new Set();
    for (const row of rows) {
      for (const ch of row) if (ch !== '.' && !(ch in palette)) unknown.add(ch);
    }
    if (unknown.size) errs.push(`${label}: palette に無い文字が使われています: ${[...unknown].join(' ')}`);
  }
  return errs;
}

/**
 * 生成 JSON の機械検証。不備の説明 (再生成プロンプトにそのまま使う日本語) の配列を返す。
 * 空配列 = 合格。キャラフレームの幅は izanami(24)/kaguya(26) と同様に可変を許す (16〜40)。
 */
export function validateGeneratedTheme(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['出力全体が JSON オブジェクトではありません。'];
  }
  const errors = [];
  if (typeof data.name !== 'string' || !data.name.trim()) errors.push('name (キャラ名) が空か欠落しています。');
  if (typeof data.personaCharacter !== 'string' || data.personaCharacter.trim().length < 20) {
    errors.push('personaCharacter (性格ブロック) が短すぎるか欠落しています。');
  }

  const charPalErrs = paletteErrors(data.char?.palette, 'char.palette');
  errors.push(...charPalErrs);
  const charPal = charPalErrs.length === 0 ? data.char.palette : null;

  const frames = data.char?.frames;
  if (!frames || typeof frames !== 'object' || Array.isArray(frames)) {
    errors.push('char.frames (idle/blink/talk) がありません。');
  } else {
    const idle = Array.isArray(frames.idle) ? frames.idle : [];
    const idleW = typeof idle[0] === 'string' ? idle[0].length : 0;
    if (idleW < 16 || idleW > 40) errors.push(`char.frames.idle の行長 ${idleW} が範囲外です (16〜40文字、推奨24)。`);
    for (const n of REQUIRED_FRAMES) {
      errors.push(...gridErrors(frames[n], charPal, `char.frames.${n}`, CHAR_FRAME_ROWS, idleW || null));
    }
  }

  const bgPalErrs = paletteErrors(data.bg?.palette, 'bg.palette');
  errors.push(...bgPalErrs);
  errors.push(...gridErrors(data.bg?.pixels, bgPalErrs.length === 0 ? data.bg.palette : null, 'bg.pixels', BG_ROWS, BG_COLS));

  return errors;
}

/**
 * 検証合格済みデータをテーマ JSON (themes/<id>/theme.json と同形) に整える。
 * 不足フレーム (joy/blush/sad/pray/sweep1/sweep2) は idle のコピーで補完する。
 * モデルが任意で出した追加フレームも、寸法と palette が合う場合のみ採用する。
 */
export function finalizeGeneratedTheme(data, id) {
  const palette = data.char.palette;
  const idle = data.char.frames.idle;
  const width = idle[0].length;
  const frames = {};
  for (const n of REQUIRED_FRAMES) frames[n] = data.char.frames[n];
  for (const n of OPTIONAL_FRAMES) {
    const f = data.char.frames[n];
    const usable = Array.isArray(f) && f.length === idle.length &&
      f.every((r) => typeof r === 'string' && r.length === width && [...r].every((ch) => ch === '.' || ch in palette));
    frames[n] = usable ? f : [...idle];
  }
  return {
    id,
    name: data.name.trim().slice(0, 24),
    personaCharacter: data.personaCharacter.trim(),
    char: { palette, frames },
    bg: { palette: data.bg.palette, pixels: data.bg.pixels },
  };
}

// テーマ生成用の 1 ターンクエリ (現在の段位のモデル・ツールなし・resume なし)
async function runThemeQuery(prompt) {
  const stream = query({
    prompt,
    options: {
      systemPrompt: 'あなたは熟練のドット絵師 (ピクセルアーティスト) 兼キャラクターデザイナーです。指示された仕様の JSON だけを出力し、JSON 以外の文章は一切出力しません。',
      model: TIER_TO_MODEL[currentTier], // 生成品質と消費は祈りの段位に従う
      settingSources: [],
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default',
    },
  });
  let text = '';
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result) {
      text = msg.result;
    }
  }
  return text;
}

/**
 * 説明文からカスタムテーマを生成して保存する。
 * 成功時は保存した theme.json の絶対パスを返し、失敗時は null を返す。
 */
export async function generateTheme(description) {
  const desc = String(description ?? '').trim().slice(0, 800);
  if (!desc) return null;
  try {
    let raw = await runThemeQuery(buildThemePrompt(desc));
    let data = parseThemeJson(raw);
    let errors = data ? validateGeneratedTheme(data) : ['出力から JSON を取り出せませんでした。'];
    if (errors.length > 0) {
      // 不備を指摘して 1 回だけ再生成
      raw = await runThemeQuery(buildRetryPrompt(desc, raw, errors.slice(0, 20)));
      data = parseThemeJson(raw);
      errors = data ? validateGeneratedTheme(data) : ['出力から JSON を取り出せませんでした。'];
      if (errors.length > 0) return null;
    }
    const id = `custom_${Date.now()}`;
    const theme = finalizeGeneratedTheme(data, id);
    const dir = path.join(DATA_ROOT, 'themes', id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'theme.json');
    writeFileSync(file, JSON.stringify(theme, null, 2));
    return file;
  } catch {
    return null;
  }
}

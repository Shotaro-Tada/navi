// テーマ JSON の機械検証 (v0.6)
//   node scripts/verify-themes.mjs
// 検証内容:
//   - 必須キー (id / name / personaCharacter / char / bg)
//   - 9 フレーム (idle,blink,talk,joy,blush,sad,pray,sweep1,sweep2) が完全な行配列
//   - フレーム格子: 24 行 x 期待列数 (izanami 24 / kaguya 26 — 箒・髪飾りが右に伸びるため)、全行同幅
//   - 全ピクセル文字が palette に存在 ('.' は透明)
//   - 背景 45 行 x 95 列、全ピクセル文字が bg.palette に存在
//   - izanami のフレーム/パレットが renderer/sprite.js の組み込み既定と完全一致
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FRAME_NAMES = ['idle', 'blink', 'talk', 'joy', 'blush', 'sad', 'pray', 'sweep1', 'sweep2'];
const EXPECT = {
  izanami: { name: 'イザナミ', frameW: 24, frameH: 24 },
  kaguya: { name: 'カグヤ', frameW: 26, frameH: 24 },
};
const BG_W = 95;
const BG_H = 45;

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

function checkPixels(rows, palette, label) {
  const unknown = new Set();
  for (const row of rows) {
    for (const ch of row) {
      if (ch !== '.' && !(ch in palette)) unknown.add(ch);
    }
  }
  check(unknown.size === 0, `${label}: 全ピクセル文字が palette に存在 (未知: ${[...unknown].join('') || 'なし'})`);
}

for (const [id, exp] of Object.entries(EXPECT)) {
  console.log(`\n== themes/${id}/theme.json ==`);
  const theme = JSON.parse(readFileSync(path.join(ROOT, 'themes', id, 'theme.json'), 'utf8'));

  check(theme.id === id, `id === '${id}'`);
  check(theme.name === exp.name, `name === '${exp.name}'`);
  check(typeof theme.personaCharacter === 'string' && theme.personaCharacter.includes('人格と口調'), 'personaCharacter に「人格と口調」節');

  const frames = theme.char?.frames ?? {};
  check(
    FRAME_NAMES.every((n) => Array.isArray(frames[n])) && Object.keys(frames).length === FRAME_NAMES.length,
    `フレーム 9 種 (${FRAME_NAMES.join(',')}) が揃い、余分なし`
  );
  for (const n of FRAME_NAMES) {
    const f = frames[n] ?? [];
    const widths = new Set(f.map((r) => (typeof r === 'string' ? r.length : -1)));
    check(
      f.length === exp.frameH && widths.size === 1 && widths.has(exp.frameW),
      `frame '${n}': ${exp.frameH} 行 x ${exp.frameW} 列 (実測 ${f.length} 行 x ${[...widths].join('/')} 列)`
    );
    checkPixels(f, theme.char.palette, `frame '${n}'`);
  }

  const bg = theme.bg?.pixels ?? [];
  const bgWidths = new Set(bg.map((r) => r.length));
  check(
    bg.length === BG_H && bgWidths.size === 1 && bgWidths.has(BG_W),
    `bg: ${BG_H} 行 x ${BG_W} 列 (実測 ${bg.length} 行 x ${[...bgWidths].join('/')} 列)`
  );
  checkPixels(bg, theme.bg.palette, 'bg');
}

// izanami テーマと sprite.js 組み込み既定の同一性
console.log('\n== izanami theme と renderer/sprite.js 既定データの一致 ==');
globalThis.window = {};
await import(pathToFileURL(path.join(ROOT, 'renderer', 'sprite.js')).href);
{
  const theme = JSON.parse(readFileSync(path.join(ROOT, 'themes', 'izanami', 'theme.json'), 'utf8'));
  const builtinFrames = globalThis.window.__NAVI_FRAMES;
  const builtinPalette = globalThis.window.__NAVI_PALETTE;
  check(
    JSON.stringify(theme.char.palette) === JSON.stringify(builtinPalette),
    'palette が __NAVI_PALETTE と一致'
  );
  for (const n of FRAME_NAMES) {
    check(
      JSON.stringify(theme.char.frames[n]) === JSON.stringify(builtinFrames[n]),
      `frame '${n}' が __NAVI_FRAMES と一致`
    );
  }
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} 件の検証失敗`);
process.exit(failures === 0 ? 0 : 1);

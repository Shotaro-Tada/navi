// generateTheme の検証・補完ロジック単体テスト (実生成なし — トークン消費ゼロ)
//   node scripts/test-generate-theme.mjs
// themes/izanami/theme.json を「モデル出力」と見立てて
// parseThemeJson → validateGeneratedTheme → finalizeGeneratedTheme を確認する。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThemeJson, validateGeneratedTheme, finalizeGeneratedTheme } from '../src/agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const izanami = JSON.parse(readFileSync(path.join(ROOT, 'themes', 'izanami', 'theme.json'), 'utf8'));

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// モデル出力相当のペイロード (仕様どおり必須3フレームのみ)
function makePayload() {
  return {
    name: izanami.name,
    personaCharacter: izanami.personaCharacter,
    char: {
      palette: { ...izanami.char.palette },
      frames: {
        idle: [...izanami.char.frames.idle],
        blink: [...izanami.char.frames.blink],
        talk: [...izanami.char.frames.talk],
      },
    },
    bg: { palette: { ...izanami.bg.palette }, pixels: [...izanami.bg.pixels] },
  };
}

console.log('== parseThemeJson ==');
{
  const fenced = '```json\n' + JSON.stringify(makePayload()) + '\n```';
  const parsed = parseThemeJson(fenced);
  check(parsed && parsed.name === izanami.name, 'コードフェンス付き出力から JSON を抽出できる');
  check(parseThemeJson('申し訳ありませんが生成できません。') === null, 'JSON が無い応答は null');
  check(parseThemeJson('{"name": 壊れたJSON}') === null, '壊れた JSON は null');
}

console.log('\n== validateGeneratedTheme: 正常系 ==');
{
  const errs = validateGeneratedTheme(makePayload());
  check(errs.length === 0, `izanami 由来ペイロード (必須3フレーム) が合格 (errors: ${errs.join(' / ') || 'なし'})`);

  const full = makePayload();
  full.char.frames = { ...izanami.char.frames }; // 9 フレーム全部入りでも合格
  check(validateGeneratedTheme(full).length === 0, '9 フレーム全部入りペイロードも合格');
}

console.log('\n== validateGeneratedTheme: 異常系 ==');
{
  const p = makePayload();
  p.char.frames.idle = p.char.frames.idle.slice(0, 23); // 行数不足
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('char.frames.idle') && e.includes('24行')), `idle 23行 → 行数エラー検出 (${errs[0] ?? ''})`);
}
{
  const p = makePayload();
  p.char.frames.talk[5] = p.char.frames.talk[5].replace('h', 'Z'); // palette に無い文字
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('char.frames.talk') && e.includes('Z')), 'talk に未知文字 Z → palette 整合エラー検出');
}
{
  const p = makePayload();
  p.char.frames.blink[3] += '.'; // 行長不一致 (25 文字)
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('char.frames.blink') && e.includes('同じ長さ')), 'blink の行長ずれ → 行長エラー検出');
}
{
  const p = makePayload();
  p.bg.pixels = p.bg.pixels.slice(0, 44); // 背景 44 行
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('bg.pixels') && e.includes('45行')), 'bg 44行 → 行数エラー検出');
}
{
  const p = makePayload();
  p.bg.pixels[10] = p.bg.pixels[10].slice(0, 94); // 背景 1 行だけ 94 文字
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('bg.pixels') && e.includes('95')), 'bg の 94 文字行 → 行長エラー検出');
}
{
  const p = makePayload();
  p.char.palette.r = 'red'; // hex 形式でない
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('char.palette') && e.includes('#rrggbb')), 'palette 値 "red" → 形式エラー検出');
}
{
  const p = makePayload();
  p.name = '';
  delete p.bg;
  const errs = validateGeneratedTheme(p);
  check(errs.some((e) => e.includes('name')) && errs.some((e) => e.includes('bg.')), 'name 空 + bg 欠落 → 両方検出');
  check(validateGeneratedTheme(null).length === 1, 'null 入力 → オブジェクトでないエラー');
}

console.log('\n== finalizeGeneratedTheme: 不足フレーム補完 ==');
{
  const theme = finalizeGeneratedTheme(makePayload(), 'custom_1234567890');
  const FRAME_NAMES = ['idle', 'blink', 'talk', 'joy', 'blush', 'sad', 'pray', 'sweep1', 'sweep2'];
  check(theme.id === 'custom_1234567890' && theme.name === izanami.name, 'id と name が設定される');
  check(
    FRAME_NAMES.every((n) => Array.isArray(theme.char.frames[n])) &&
      Object.keys(theme.char.frames).length === FRAME_NAMES.length,
    '9 フレームが揃う (joy/blush/sad/pray/sweep1/sweep2 を補完)'
  );
  const idleStr = JSON.stringify(theme.char.frames.idle);
  check(
    ['joy', 'blush', 'sad', 'pray', 'sweep1', 'sweep2'].every((n) => JSON.stringify(theme.char.frames[n]) === idleStr),
    '補完フレームは idle のコピー'
  );
  check(theme.char.frames.joy !== theme.char.frames.idle, '補完フレームは idle と別配列 (参照を共有しない)');
  check(
    JSON.stringify(theme.bg) === JSON.stringify(izanami.bg) && typeof theme.personaCharacter === 'string',
    'bg と personaCharacter がそのまま保持される'
  );
}
{
  // モデルが任意フレームを出した場合: 寸法/palette が合えば採用、壊れていれば idle で置換
  const p = makePayload();
  p.char.frames.joy = [...izanami.char.frames.joy]; // 正しい任意フレーム
  p.char.frames.sad = ['xxx']; // 壊れた任意フレーム
  const theme = finalizeGeneratedTheme(p, 'custom_x');
  check(JSON.stringify(theme.char.frames.joy) === JSON.stringify(izanami.char.frames.joy), '正しい任意フレーム joy は採用');
  check(JSON.stringify(theme.char.frames.sad) === JSON.stringify(izanami.char.frames.idle), '壊れた任意フレーム sad は idle で置換');
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} 件の検証失敗`);
process.exit(failures === 0 ? 0 : 1);

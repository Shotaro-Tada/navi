# NAVI.exe

ドット絵のオリジナルキャラクター「NAVI」が Claude を頭脳として常駐し、生活・研究をサポートする Windows アプリ。ロックマンエグゼの「ナビ」に着想 (デザイン・コードは完全オリジナル)。

## 仕組み

- **Electron** — フレームレス・常時最前面の小窓 (PET 端末風)
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code をライブラリとして組み込み。**Claude Code にログイン済みの Max サブスクリプション認証をそのまま使うため API 従量課金なし** (使用量は Max プランの上限を共有)
- **モデルは Sonnet 固定** (日常用途のトークン消費抑制。`src/agent.js` の `MODEL` 定数)
- 会話セッションは `resume` で継続。ツールは読み取り系 (Read/Glob/Grep/WebSearch/WebFetch) + **自分の記憶領域 (`memory/`) 内に限った書き込み** (予定の書き留め等。`canUseTool` で経路を機械的に制限)
- キャラクター: 巫女装束の女性 (24×24 ドット、まばたき/口パク)。背景: 伊勢神宮風の神明造 (千木・鰹木・茅葺き・白木の鳥居・玉砂利) の夜景

## 記憶システム (v0.3 — 生態系記憶)

- **索引 + 個別ファイル + アーカイブ**の三層構造。`memory/NAVI_MEMORY.md` (索引) だけが毎回 system prompt へ注入され、詳細は `memory/mem_*.md` をイザナミが必要時に Read する (progressive disclosure)
- **固定化 + 剪定**: タイトルバーの **⛩ ボタン**で手動実行、または**ウィンドウを閉じた時に自動実行** (最大60秒、その後終了)。詳細は個別ファイルへ、新主題はファイル新規作成+索引に1行追加。剪定で消す代わりに歴史的価値のあるものは `memory/archive/` へ退避 (誤剪定からの復元が可能)
- 目安: 索引80行以内・個別ファイル各150行以内。記憶の総量はファイル数で伸びるため、毎ターンの注入コストは索引サイズのまま一定
- 安全装置: 固定化中の書き込みは `canUseTool` コールバックで `memory/` ディレクトリ内のみに制限
- Claude Code 側の MEMORY.md とは完全に独立 (人格分離)。`settingSources: []` により、ユーザー設定 (settings.json のフック・CLAUDE.md・既定モデル) は一切読み込まない — イザナミが起動時に読むのは自分の `NAVI_MEMORY.md` だけ
- キャラクター名と呼び方は `NAVI_MEMORY.md` から起動時にパースされ、タイトルバー・入力欄・挨拶に反映される (名前変更は会話→⛩固定化→再起動で追従)

## 起動

```powershell
cd C:\Users\Shotaro\work\TOOL-navi
npm start
```

> ⚠️ VS Code 内のターミナルから起動する場合は、先に `ELECTRON_RUN_AS_NODE` を消すこと
> (VS Code がこの変数を子プロセスに継承し、Electron がただの Node として動いてしまうため):
>
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm start
> ```
>
> 通常のターミナルやショートカットからの起動では不要。

## ファイル構成

| パス | 役割 |
|---|---|
| `src/main.js` | Electron メインプロセス (ウィンドウ + IPC) |
| `src/agent.js` | Agent SDK ブリッジ。`NAVI_PERSONA` = 人格定義 (ここを編集すればキャラが変わる) |
| `src/preload.cjs` | contextBridge (renderer への安全な API 公開) |
| `renderer/sprite.js` | 16×16 ドット絵スプライト定義 + アニメーション (まばたき/口パク) |
| `renderer/app.js` | チャット UI ロジック |

## スケジューラとモデル切替 (v0.4)

- **定時リマインド**: `config.json` の `reminder.time` (既定 07:00) を過ぎた最初のチェック (30秒間隔、起動15秒後にも実行) で、イザナミが `mem_schedule.md` を確認して当日の予定をチャットに案内し、OS 通知も表示する。1日1回 (`lastFired` で管理)。アプリが起動している必要がある
- **モデル切替タブ**: ステージ右上の Sonnet / Opus / Fable。選択は `config.json` に永続化。記憶の固定化は常に Sonnet で実行 (整理にコストをかけない)
- **オーラ演出**: 祈りの力の消費量に応じてイザナミからオーラが立ち上る — Sonnet: なし / Opus: 金色の炎 / Fable: より大きな光輝の炎 + 火の粉 (`renderer/aura.js`)

## 暮らしの演出と感情 (v0.5)

- **確率演出** (30秒ごとに抽選、会話中は休止): 箒を取り出して境内を掃く (8%)・流れ星に祈る (4%)・新奇演出 (0.2%、1日1回まで)
- **感情表現**: イザナミが応答末尾に不可視タグ [emo:joy/blush/sad/none] で感情を自己申告し、表情 (喜び・頬染め・悲しみ) が数秒表示される
- **新奇演出**: Sonnet の極小クエリでイザナミが天候 (雪/雨/蛍/花びら) と和の一言を選び、境内に降らせる。効果は安全な語彙に限定し、描画はアプリ側部品が担当

## 将来構想

- キャラクターデザインの本格化 (sprite.js の文字マップを差し替え)
- リマインダー/スケジュール (カスタムツール化)、システムトレイ常駐、通知
- スマホアプリ化: UI 層 (HTML/Canvas) は Capacitor 等で流用可。ただし**サブスクリプション認証は本人のローカル利用限定**のため、公開時はバックエンドを Claude API (ユーザー各自のキー等) に差し替える必要がある

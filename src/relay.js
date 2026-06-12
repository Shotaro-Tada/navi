// ---- PC リレーサーバ (v0.8) ----
// Android 版 NAVI がこの PC の NAVI と会話するための HTTP 入口。
// Node 標準 http のみで実装し、Electron / Agent SDK には依存しない。
// 依存 (ask・busy フラグ・テーマ名など) は main.js から注入される (単体テスト可能にするため)。
// 認証は Bearer トークン (config.relay.token)。listen は 0.0.0.0 (LAN / Tailscale 用)。
// 既定では config.relay.enabled = false なので、現運用には影響しない。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_RELAY_PORT = 17760;
const MAX_BODY_BYTES = 1024 * 1024; // /ask ボディ上限 1MB

// Authorization: Bearer <token> の検証。トークン比較は定数時間 (timingSafeEqual)。
// 長さが異なる場合のみ早期 false (timingSafeEqual は同長バッファ必須のため)。
function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(String(header ?? ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// リクエストボディを JSON として読む (上限超過・不正 JSON は reject)
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * リレーサーバを生成する (listen はしない — 単体テスト用に分離)。
 * deps:
 * - token: Bearer 認証トークン (必須)
 * - ask: agent.js の ask (非同期ジェネレータ)
 * - isBusy / setBusy: main.js の chatBusy フラグの読み書き (チャットと排他)
 * - getName: テーマ表示名を返す関数
 * - version: アプリバージョン文字列
 * - memoryPath: NAVI_MEMORY.md の絶対パス
 */
export function createRelayServer(deps) {
  return http.createServer(async (req, res) => {
    try {
      // 全エンドポイントで認証必須 (不一致・欠落は 401)
      if (!tokenMatches(req.headers.authorization, deps.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: deps.getName?.() || 'NAVI',
          version: deps.version ?? '0.0.0',
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/ask') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String(err?.message ?? err) });
          return;
        }
        const text = String(body?.text ?? '').trim();
        if (!text) {
          sendJson(res, 400, { error: 'text is required' });
          return;
        }
        if (deps.isBusy?.()) {
          sendJson(res, 429, { error: 'busy' }); // PC 側のチャット/リマインド等と排他
          return;
        }
        deps.setBusy?.(true);
        try {
          // ask() を完走させてチャンクを結合 (main.js のリマインド表示と同じ改行結合)。
          // [emo:…] タグは除去せずそのまま返す — モバイル側で表情に使う。
          let reply = '';
          for await (const chunk of deps.ask(text)) {
            reply += (reply ? '\n' : '') + chunk;
          }
          sendJson(res, 200, { reply });
        } catch (err) {
          sendJson(res, 500, { error: String(err?.message ?? err) });
        } finally {
          deps.setBusy?.(false);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/memory/index') {
        try {
          sendJson(res, 200, { index: readFileSync(deps.memoryPath, 'utf8') });
        } catch {
          sendJson(res, 404, { error: 'memory index not found' });
        }
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      try {
        sendJson(res, 500, { error: String(err?.message ?? err) });
      } catch { /* 応答送出済みなら無視 */ }
    }
  });
}

/**
 * リレーサーバを 0.0.0.0 で起動する (LAN / Tailscale から到達可能)。
 * ポート使用中などの失敗はログのみで、アプリ本体を止めない。
 */
export function startRelay(deps) {
  const server = createRelayServer(deps);
  const port = Number(deps.port) || DEFAULT_RELAY_PORT;
  server.on('error', (err) => console.log('[relay] error:', err?.message ?? err));
  server.listen(port, '0.0.0.0', () => console.log(`[relay] listening on 0.0.0.0:${port}`));
  return server;
}

/**
 * LINE 公式アカウントの設定を、Worker 自身が行う。
 *
 * ★これまでは `scripts/setup-line.mjs`（顧客のパソコンで動かすコマンド）がやっていた。
 *   ターミナルを開かせないために、同じことを Worker の中でやる。
 *
 * ★Webhook の URL は、**このリクエストが届いた場所**から作る（引数で受け取る）。
 *   決め打ちにすると、他人の Worker を向けてしまう事故が起きる（過去に実際に埋め込んでいた）。
 */
import { log } from '../../lib/mask';
import { switchTo, forgetMenus, menuFor } from './richmenu';

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

/** 1手順の結果。画面にそのまま並べられる形にしておく */
export interface Step {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ProvisionResult {
  ok: boolean;
  steps: Step[];
  /** 設定した Webhook の URL（確認用） */
  webhookUrl?: string;
}

async function call(
  token: string, method: string, path: string, body?: unknown,
  opts: { base?: string; contentType?: string } = {},
): Promise<any> {
  const base = opts.base ?? API;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;

  if (body instanceof Uint8Array) {
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    // ★トークンは絶対に混ぜない。返ってきた本文だけを見せる
    throw new Error(`LINE API ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Webhook の設定と疎通確認。
 *
 * ★配備した直後はアドレスが行き渡っていないことがある。
 *   1回で失敗と決めつけない（実際に「成功しているのに失敗表示」が起きた）。
 */
async function setupWebhook(token: string, origin: string, steps: Step[]): Promise<string> {
  const endpoint = `${origin.replace(/\/+$/, '')}/line/webhook`;

  await call(token, 'PUT', '/channel/webhook/endpoint', { endpoint });
  steps.push({ label: 'Webhook の設定', ok: true, detail: endpoint });

  let passed = false;
  let lastReason = '';
  for (let i = 0; i < 3; i++) {
    try {
      const test = await call(token, 'POST', '/channel/webhook/test', { endpoint });
      if (test.success === true || test.statusCode === 200) { passed = true; break; }
      lastReason = String(test.reason ?? test.detail ?? '');
    } catch (e) {
      lastReason = String(e);
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 5_000));
  }

  steps.push(passed
    ? { label: 'LINE から届くかの確認', ok: true }
    : { label: 'LINE から届くかの確認', ok: false,
        detail: `${lastReason}（配備直後は数分かかることがあります。少し待ってからやり直してください）` });

  return endpoint;
}

/**
 * LINE 側の設定をまとめて行う。
 *
 * @param origin このシステム自身の住所（`https://〇〇.workers.dev`）
 */
export async function provisionLine(
  token: string, origin: string, kv: KVNamespace, noteConnected: boolean,
): Promise<ProvisionResult> {
  const steps: Step[] = [];
  let webhookUrl: string | undefined;

  try {
    const me = await call(token, 'GET', '/info');
    steps.push({ label: 'LINE への接続', ok: true, detail: `${me.displayName ?? ''} ${me.basicId ?? ''}`.trim() });
  } catch (e) {
    steps.push({ label: 'LINE への接続', ok: false, detail: String(e) });
    return { ok: false, steps };
  }

  try {
    webhookUrl = await setupWebhook(token, origin, steps);

    // ★メニューは作り直す（画像を差し替えたときに反映されるように）。
    //   まだ note と繋がっていなければ、セットアップ用の2ボタンを出す
    await forgetMenus(kv);
    const kind = menuFor(noteConnected);
    const ok = await switchTo(token, kv, kind);
    steps.push(ok
      ? { label: 'メニューの作成', ok: true,
          detail: kind === 'setup' ? 'セットアップ用（2ボタン）' : '通常（3ボタン）' }
      : { label: 'メニューの作成', ok: false,
          detail: 'メニュー画像を取得できませんでした。文字を打てば操作はできます' });
  } catch (e) {
    log.warn('LINE の設定でつまずきました', String(e));
    steps.push({ label: '設定の続行', ok: false, detail: String(e) });
  }

  return { ok: steps.every((s) => s.ok), steps, webhookUrl };
}

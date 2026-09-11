/**
 * 裏方。定期的にサーバーへ「やることある？」と聞きに行き、あれば note へ投稿する。
 *
 * ★これがあることで、note から見た投稿元が**お使いのパソコン**になる。
 *   サーバーからまとめて投稿すると、note からは1つの出どころに見えるため、
 *   1件がスパム判定されると利用者全員が巻き添えになる。
 *
 * ★ここでも note の仕様は判断しない。手順書のとおりに実行するだけ（plan-runner.js）。
 */
import { runPlan, PlanError } from './plan-runner.js';

// ★接続先は焼き込まない。全員に同じものを配り、設定画面で1回入れてもらう。
//   焼き込む方式だと、例文のまま作っても成功してしまい気づけなかった（2026-08-30 実際に事故）。
const DEFAULT_ENDPOINT = '';
const ALARM = 'poll-jobs';
/** 何分ごとに聞きに行くか（Chrome の最小値は1分）。 */
const PERIOD_MINUTES = 1;

// ── 設定 ─────────────────────────────────────────────
async function config() {
  const { endpoint, deviceToken } = await chrome.storage.local.get(['endpoint', 'deviceToken']);
  return {
    endpoint: (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    token: deviceToken || '',
  };
}

async function api(path, { method = 'POST', body } = {}) {
  const { endpoint, token } = await config();
  if (!token) return null;   // まだ連携していない
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // 連携が切れている。聞きに行くのをやめて、次の連携を待つ
    await chrome.storage.local.remove('deviceToken');
    await setBadge('!', '#b91c1c');
    return null;
  }
  return res;
}

// ── 画像の受け取り ────────────────────────────────────
async function fetchAsset(assetId) {
  const { endpoint, token } = await config();
  const res = await fetch(`${endpoint}/agent/asset/${encodeURIComponent(assetId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new PlanError(`画像を取得できませんでした（${res.status}）`);
  return res.blob();
}

// ── 本体 ─────────────────────────────────────────────
let running = false;

export async function pollOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    const res = await api('/agent/poll');
    if (!res || !res.ok) return { skipped: true };

    const { job } = await res.json();
    if (!job) {
      await setBadge('', '#2cb696');
      return { job: null };
    }

    await setBadge('…', '#2cb696');
    console.log('[note連携] 実行します', job.id, job.kind);

    try {
      const { vars } = await runPlan(job.plan, {
        fetchNote: (url, init) => fetch(url, init),
        fetchAsset,
        onStep: (id) => console.log('[note連携]  →', id),
      });
      await api('/agent/result', { body: { jobId: job.id, ok: true, vars } });
      await setBadge('✓', '#15803d');
      console.log('[note連携] 完了しました', job.id);
      return { job: job.id, ok: true };
    } catch (e) {
      const err = {
        message: String(e?.message ?? e).slice(0, 500),
        status: e instanceof PlanError ? e.status : 0,
        code: e instanceof PlanError ? e.code : '',
        stepId: e instanceof PlanError ? e.stepId : null,
      };
      await api('/agent/result', { body: { jobId: job.id, ok: false, error: err } });
      await setBadge('!', '#b91c1c');
      console.warn('[note連携] 失敗しました', err);
      return { job: job.id, ok: false, error: err };
    }
  } catch (e) {
    // 通信できないだけのことが多い。次の周期で拾い直す
    console.warn('[note連携] 接続できませんでした', e);
    return { skipped: true };
  } finally {
    running = false;
  }
}

async function setBadge(textValue, color) {
  try {
    await chrome.action.setBadgeText({ text: textValue });
    if (textValue) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* アイコンが無い状況では気にしない */ }
}

// ── 起動と定期実行 ────────────────────────────────────
function schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 0 });
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pollOnce();
});

/** ポップアップから「いますぐ確認して」と言われたとき。 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'poll-now') {
    pollOnce().then(sendResponse);
    return true;   // 非同期で返す
  }
  return false;
});

schedule();

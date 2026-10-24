/**
 * セットアップで点検する値の一覧と、その形の検査。
 *
 * ★setup.mjs から切り出しているのは、テストで読めるようにするため
 *   （setup.mjs は読み込んだ瞬間に動き出すので、テストから import できない）。
 *
 * 方針（P4-1・2026-10-23）:
 *   顧客が用意する外部のキーは **OpenAI の API キー1つだけ**。
 *   Claude（ANTHROPIC_*）は、Claude で動いている既存・移行中の環境のためだけに任意で残す。
 *   どちらで文章を書くかは src/ports/llm/index.ts の chooseProvider が決める
 *   （LLM_PROVIDER の明示 > Claude のキーがあれば Claude > OpenAI）。ここでは変えない。
 */

/** OpenAI のキーの取り方と、最初に知っておいてほしいこと（足りないときに表示する） */
export const OPENAI_KEY_GUIDE = [
  'platform.openai.com → 右上の歯車（Settings）→ API keys →「Create new secret key」（sk- で始まる）',
  '      ・先に Billing で前払いのクレジットを買ってください（最低5ドル）。残高が0だと記事が作れません',
  '      ・★自動チャージ（Auto recharge）はオフのままにしてください。前払い残高が使いすぎの歯止めになります',
  '      ・画像の生成などで「組織の認証（Verify Organization）」を求められる場合があります（Settings → Organization → General）',
  '      ・費用の目安: 記事1本 約20〜30円／Webで調べると＋約3〜11円／AI画像1枚 約4〜5円（どれも目安。お使いのぶんだけ減ります）',
  '      ・ChatGPT（Plus など）の月額プランとは別物です。API の支払い登録が別に要ります',
].join('\n');

/** OpenAI の API キーの形を確かめる。問題なければ null、あれば理由を返す */
export function validateOpenAiKey(v) {
  if (!v) return null;
  const s = String(v);
  if (/\s/.test(s)) return 'キーの途中か前後に空白・改行が入っています。コピーし直して貼ってください';
  // ★Claude のキー（sk-ant-）を OpenAI の欄に貼る取り違えを先に止める
  if (s.startsWith('sk-ant-')) return 'これは Claude（Anthropic）のキーです。OpenAI のキー（platform.openai.com で発行・sk- で始まる）を貼ってください';
  if (!s.startsWith('sk-')) return 'sk- から始まる値である必要があります（platform.openai.com → API keys で発行したキー）';
  if (s.length < 20) return 'キーが短すぎます。途中で切れていないか確かめてください';
  return null;
}

/** Claude のキー（任意）。入っているときだけ形を見る */
export function validateAnthropicKey(v) {
  if (!v) return null;
  return String(v).startsWith('sk-ant-') ? null
    : 'sk-ant- から始まる値である必要があります。Claude を使わないなら空欄にしてください';
}

/** Claude のワークスペースID（任意）。入っているときだけ形を見る */
export function validateAnthropicWorkspaceId(v) {
  if (!v) return null;
  return String(v).startsWith('wrkspc_') ? null
    : 'wrkspc_ から始まる値である必要があります（Console の Settings → Workspaces）。空欄でも動きます';
}

/** 文章の提供元の明示（任意） */
export function validateLlmProvider(v) {
  if (!v) return null;
  return /^(openai|anthropic)$/.test(String(v).trim().toLowerCase()) ? null
    : 'openai か anthropic のどちらかです。空欄なら自動で決まります';
}

/**
 * 必要な値と、その取り方。
 * required=false のものは、無くても動く。
 */
export const VARS = [
  { key: 'LINE_CHANNEL_SECRET', required: true, secret: true,
    where: 'LINE Developers → チャネル基本設定 → チャネルシークレット' },
  { key: 'LINE_CHANNEL_ACCESS_TOKEN', required: true, secret: true,
    where: 'LINE Developers → Messaging API設定 → チャネルアクセストークン（長期）' },
  // ★文章・調査・画像はすべてこのキー1つで動く
  { key: 'OPENAI_API_KEY', required: true, secret: true,
    validate: validateOpenAiKey, where: OPENAI_KEY_GUIDE },
  // ── ここから Claude（任意）。Claude で動いている既存・移行中の環境のためだけに残している ──
  //   Claude のキーが入っていると、LLM_PROVIDER を書かない限り文章は Claude のまま動く。
  //   新しい環境では空のままにする。
  { key: 'ANTHROPIC_API_KEY', required: false, secret: true,
    validate: validateAnthropicKey,
    where: '空でOK（Claude で動いている既存の環境だけ。console.anthropic.com の従量課金キー）' },
  // ★形の検査を付ける。付け忘れると「設定したのに動かない」になる（2026-08-30 実地）
  { key: 'ANTHROPIC_WORKSPACE_ID', required: false, secret: true,
    validate: validateAnthropicWorkspaceId,
    where: '空でOK（Claude を使い、キーがワークスペースに紐づいている場合だけ。wrkspc_ で始まるID）' },
  { key: 'LLM_PROVIDER', required: false, secret: true,
    validate: validateLlmProvider,
    where: '空でOK（自動: Claude のキーがあれば Claude、無ければ OpenAI。明示するときは openai / anthropic）' },
  { key: 'MASTER_KEY_V1', required: true, secret: true, generate: true,
    where: '自動生成します（note のログイン情報を暗号化する鍵）' },
  { key: 'LINE_OWNER_USER_ID', required: false, secret: true,
    where: '空でOK。最初にメッセージを送った人を自動でオーナー登録します' },
  { key: 'NOTE_COOKIE', required: false, secret: true,
    where: '空でOK。拡張機能で連携します（サーバー投稿方式のときだけ使う逃げ道）' },
  { key: 'NOTE_USER_AGENT', required: false, secret: true, where: '同上' },
  { key: 'NOTE_URLNAME', required: false, secret: true, where: '同上' },
];

/**
 * /health の checks のうち、「ok 以外の値でも正常」なもの。
 * llm は提供元の名前（openai / anthropic）、thumbnail は enabled / disabled を返すため。
 */
export function isHealthyCheck(key, value) {
  const v = String(value);
  if (v === 'ok') return true;
  if (key === 'execution_mode') return true;
  if (v.startsWith('agent/') || v.startsWith('extension/')) return true;
  if (key === 'llm') return v === 'openai' || v === 'anthropic';
  if (key === 'thumbnail') return v === 'enabled' || v.startsWith('disabled');
  return false;
}

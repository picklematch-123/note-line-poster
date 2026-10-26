/**
 * OpenAI の文章生成（Responses API）。
 *
 * ★モデル名は入れ替わりが激しい（2026-10 時点で gpt-5.x / gpt-6.x が混在）。
 *   そこで用途ごとに「候補の並び」を持ち、先頭が使えなければ次を自動で使う。
 *   顧客の環境は独立した複製で、こちらから直せないため、止まらない作りにしておく。
 *   全部だめなら日本語で知らせる。
 * ★候補の「使える/使えない」は、モデル一覧に載っているかではなく、実際に呼んだ結果で決める。
 * ★BYOK: 顧客自身の OpenAI API キー。
 */
import { log } from '../../lib/mask';
import { bytesToBase64 } from '../../lib/base64';
import {
  LlmError, DEFAULT_STRUCTURED_MAX_RETRIES, extractJson,
  type Llm, type LlmResult, type LlmUsage, type ModelTier, type StructuredOptions, type VisionOptions,
} from './types';

const API = 'https://api.openai.com/v1/responses';

/**
 * 既定の候補（先頭ほど優先）。2026-10-23 に実際に呼べることを確認したもの。
 * 環境変数 OPENAI_MODEL_HEAVY / OPENAI_MODEL_LIGHT（カンマ区切り）で上書きできる。
 */
export const DEFAULT_CANDIDATES: Record<ModelTier, string[]> = {
  heavy: ['gpt-6.1-sol', 'gpt-5.5', 'gpt-5.4'],
  light: ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-5.4-nano'],
};

/**
 * Webリサーチ（P2）用の候補。環境変数 OPENAI_MODEL_RESEARCH（カンマ区切り）で上書きできる。
 * ★P0 実測（2026-10-23）: luna は1調査 約2円、sol は約11円。事実メモの JSON はどちらも有効。
 *   調査は「探して拾う」仕事なので安い側を先に置く。品質を見て並びを変える。
 * ★ModelTier に足さない理由: Claude の窓口（anthropic.ts）は調査をしないので、型を広げると
 *   向こうにも対応が要るように見えてしまう。調査は OpenAI だけの機能として分けておく。
 */
export const DEFAULT_RESEARCH_CANDIDATES = ['gpt-6-luna', 'gpt-5.4-mini'];

/**
 * vision = 画像を見て判定する（サムネの検品・2026-10-26）。light の候補を先に、だめなら heavy の候補。
 * ★画像を受け付けないモデルは「使えないモデル」として次の候補へ進む（課金されないため）
 */
type CandidateKey = ModelTier | 'research' | 'vision';

/** 推論型は「考える分」も出力の上限に数える。本文が途中で切れないよう余裕を足す */
const REASONING_HEADROOM = 6000;

/**
 * Webリサーチ1回の通信の時間切れ（★2026-10-24 源蔵レビュー必須2）。
 * 時間切れが無いと、応答が返らないとき step の 5分の時間切れまで待ち、記事の生成ごと黙って止まる。
 * P0 実測は 11〜32 秒。候補を2つ試しても 4 分で、step の 5 分に収まる。
 */
export const RESEARCH_TIMEOUT_MS = 120_000;

/**
 * 文章（記事の構成・本文・仕上げ・意図分類など）1回の通信の時間切れ（★2026-10-24 源蔵 再レビュー「後でよい」）。
 * 時間切れが無いと、応答が返らないとき step「記事を生成する」の 10 分の時間切れまで待ち、
 * やり直しも同じく固まると、記事が「生成中」のまま止まって LINE にも何も届かなかった。
 * ★時間切れは kind='timeout'・recoverable（一時的なもの）として、structured の再試行の上限内でやり直す。
 *   本文1回は通常 1〜2 分（推論型は考える分も含む）なので、目安として 180 秒。
 */
export const TEXT_TIMEOUT_MS = 180_000;

/** 画像の検品1回の通信の時間切れ。検品は短い JSON を返すだけなので、文章より短くする */
export const VISION_TIMEOUT_MS = 90_000;

export interface OpenAiLlmOptions {
  heavy?: string[];
  light?: string[];
  research?: string[];
  /** Webリサーチの通信の時間切れ（ミリ秒）。テストで短くするためのもの */
  researchTimeoutMs?: number;
  /** 文章の通信の時間切れ（ミリ秒）。テストで短くするためのもの */
  textTimeoutMs?: number;
  /** 画像の検品の通信の時間切れ（ミリ秒）。テストで短くするためのもの */
  visionTimeoutMs?: number;
}

export function parseCandidates(raw: string | undefined | null): string[] | undefined {
  const list = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
    /** web_search_call のとき。検索（sources つき）とページを開いた操作（url）がある */
    action?: { type?: string; url?: string; sources?: Array<{ type?: string; url?: string; title?: string }> };
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Webリサーチ1回の依頼 */
export interface WebResearchOptions {
  system: string;
  user: string;
  /** JSON Schema（strict）。出力の形をここで縛る */
  jsonSchema: Record<string, unknown>;
  /** 検索ツールの呼び出し回数の上限（費用の歯止め） */
  maxToolCalls: number;
  /** 調べる先の限定（空なら指定なし） */
  allowedDomains?: string[];
  maxTokens?: number;
}

/** Webリサーチの生の結果。検査（core/research/vet.ts）はこれを入力にする */
export interface WebResearchRaw {
  /** モデルが書いた本文（JSON のはず。検証は呼び出し側） */
  text: string;
  /** 検索で参照したURL一覧（web_search_call.action.sources と、開いたページ） */
  sources: Array<{ url: string; title?: string }>;
  /** 本文に付いた url_citation */
  citations: Array<{ url: string; title?: string }>;
  /** 実際に検索ツールが呼ばれた回数（費用の記録用） */
  toolCalls: number;
  usage: LlmUsage;
  model: string;
}

/**
 * OpenAI の文章モデル向けの書き方の補足（記事の構成・本文・仕上げの3つだけに足す）。
 *
 * ★2026-10-24 の並べ比べ（オーナー 採点）で見えた癖を直すためのもの。
 *   ・「断定しない」を字義どおりに受け取り、「この記事では確認済みの情報がありません」
 *     「ご確認ください」と、記事自身について断り書きを連発する → 人間味が落ちる
 *   ・表を使う（本文プロンプトは禁止している）・指定の文字数より短い
 *   ・構成が薄い（SEO の点が低かった）
 * ★足してはいけない事実を足さない、という方向は Claude 版より厳しくしてある
 *   （Claude 版は元ネタに無い事実を書き足していた）。
 */
export const WRITING_ADDENDUM = `
【書き方の補足（必ず守る）】
1. 読者に向けた記事として書く。「この記事では確認済みの情報がありません」「ご案内していません」のように、記事自身についての断り書きや説明は書かない。分からないことは、書かずに省く。
2. 元ネタとナレッジに書かれていない具体的な事実（金額・日付・営業時間・設備・仕組み・数字・体験談）は足さない。詳細を確認してほしいときは「詳しくはお店へお問い合わせください」のように、記事全体で1回だけ、短く触れる。「要確認」「ご確認ください」を繰り返さない。
3. 書き手の立場（店主など）の声で、具体的な情景・気持ち・読者への語りかけを入れ、人が書いた温度のある文章にする。ナレッジに書かれた強み・こだわりは、自分の言葉で自然に語る。
4. 表は使わない。箇条書きは1記事に1〜2か所まで。見出しは読者の疑問や期待の形にし、各見出しの下で1つの問いに答え切る。
5. ネタに文字数の指定（「2500字くらい」など）があれば、本文全体がその±10%に収まるまで書き込む。指定がなければ、構成で決めた目安の合計を下回らないようにする（短くまとめすぎない）。
6. 販売や来店を促す記事なら、最後に自然な行動の呼びかけを1つだけ置く。`;

/** 補足を足す対象（呼び出しの label）。意図分類・ナレッジ整理などには足さない */
const ADDENDUM_LABELS = new Set(['構成作成', '本文執筆', 'SEO仕上げ']);

export function withAddendum(label: string, system: string): string {
  return ADDENDUM_LABELS.has(label) ? `${system}\n${WRITING_ADDENDUM}` : system;
}

/**
 * ★OpenAI は text.format が json_object のとき、「入力の中」に json という語が必要で、無いと 400 で断る
 *   （指示文 instructions の中にあっても数えられない）。2026-10-24 の実機確認で、
 *   画像の指示文づくり（ユーザー文に JSON と書いていない呼び出し）が全部この 400 で失敗した。
 *   呼び出しごとの書き忘れに頼らず、窓口で必ず足す。
 */
export function ensureJsonWord(user: string): string {
  return /json/i.test(user) ? user : `${user}\n\n（出力は JSON オブジェクトのみ）`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AbortSignal.timeout による打ち切りか */
function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export class OpenAiLlm implements Llm {
  private readonly candidates: Record<CandidateKey, string[]>;
  /** この実行の間に「使えた」モデル。毎回先頭から試して無駄な往復をしないため */
  private readonly working: Partial<Record<CandidateKey, string>> = {};

  private readonly researchTimeoutMs: number;
  private readonly textTimeoutMs: number;
  private readonly visionTimeoutMs: number;

  constructor(private readonly apiKey: string, opts: OpenAiLlmOptions = {}) {
    if (!apiKey?.startsWith('sk-')) {
      throw new LlmError('OpenAI キーの形式が不正',
        'OpenAI の API キーが正しく登録されていません。platform.openai.com で発行したキー（sk- で始まるもの）をご登録ください。',
        false, undefined, 'auth');
    }
    const heavy = opts.heavy ?? DEFAULT_CANDIDATES.heavy;
    const light = opts.light ?? DEFAULT_CANDIDATES.light;
    this.candidates = {
      heavy,
      light,
      research: opts.research ?? DEFAULT_RESEARCH_CANDIDATES,
      vision: [...new Set([...light, ...heavy])],
    };
    this.researchTimeoutMs = opts.researchTimeoutMs ?? RESEARCH_TIMEOUT_MS;
    this.textTimeoutMs = opts.textTimeoutMs ?? TEXT_TIMEOUT_MS;
    this.visionTimeoutMs = opts.visionTimeoutMs ?? VISION_TIMEOUT_MS;
  }

  /**
   * 1回 POST する。失敗は日本語の LlmError にして投げる（候補の切替は呼び出し側）。
   * ★timeoutMs を過ぎたら打ち切る（kind='timeout'・再試行しない）。本文の受け取り中も時間切れの対象
   */
  private async post(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<ResponsesBody> {
    const isTimeout = isAbort;
    const timeoutError = (e: unknown) => new LlmError(`timeout after ${timeoutMs}ms: ${String(e)}`,
      'OpenAI の応答に時間がかかりすぎたため、打ち切りました。', false, 0, 'timeout');
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model, ...body }),
        signal,
      });
    } catch (e) {
      if (isTimeout(e) || signal.aborted) throw timeoutError(e);
      throw new LlmError(String(e), '記事の生成中に通信エラーが発生しました。', true, 0, 'temp');
    }
    let raw: string;
    try { raw = await res.text(); } catch (e) {
      if (isTimeout(e) || signal.aborted) throw timeoutError(e);
      throw new LlmError(String(e), '記事の生成中に通信エラーが発生しました。', true, res.status, 'temp');
    }
    if (!res.ok) throw classify(res.status, raw, model);
    try { return JSON.parse(raw) as ResponsesBody; } catch {
      throw new LlmError('応答が JSON でない', '記事の生成中にエラーが発生しました。', true, res.status, 'temp');
    }
  }

  /**
   * Web で調べる（Responses API の web_search ツール）。
   *
   * ★再試行しない: 検索した時点で課金されるため。一時エラーでもそのまま投げる（呼び出し側で「調べられなかった」扱い）。
   * ★通信は RESEARCH_TIMEOUT_MS（120秒）で打ち切る。時間切れは候補の切替もしない（次のモデルでも待つだけになる）。
   *   候補の切替だけは行う（使えないモデルは課金されない）。
   * ★ここは「データを取ってくる」だけ。書き込み系のツールは一切渡さない。
   */
  async webResearch(opts: WebResearchOptions): Promise<WebResearchRaw> {
    const tool: Record<string, unknown> = { type: 'web_search', search_context_size: 'low' };
    if (opts.allowedDomains?.length) tool.filters = { allowed_domains: opts.allowedDomains.slice(0, 100) };
    const body = {
      instructions: opts.system,
      input: opts.user,
      tools: [tool],
      max_tool_calls: opts.maxToolCalls,
      // ★顧客の元ネタ・記事を OpenAI 側に「保存済みの応答」として残さない（既定の保存は30日。公式 your-data で確認）。
      //   ※不正利用の監視用ログ（最大30日）は、この指定では消えない（ゼロデータ保持は別契約）
      store: false,
      include: ['web_search_call.action.sources'],
      max_output_tokens: (opts.maxTokens ?? 3000) + REASONING_HEADROOM,
      text: { format: { type: 'json_schema', name: 'research_facts', strict: true, schema: opts.jsonSchema } },
    };
    const { model, out: j } = await this.withCandidates('research', (m) => this.post(m, body, this.researchTimeoutMs));

    const sources: WebResearchRaw['sources'] = [];
    const citations: WebResearchRaw['citations'] = [];
    let toolCalls = 0;
    let text = '';
    for (const o of j.output ?? []) {
      if (o.type === 'web_search_call') {
        toolCalls++;
        for (const s of o.action?.sources ?? []) if (s.url) sources.push({ url: s.url, title: s.title });
        if (o.action?.url) sources.push({ url: o.action.url });
      }
      if (o.type === 'message') {
        for (const c of o.content ?? []) {
          if (c.type !== 'output_text') continue;
          text += c.text ?? '';
          for (const a of c.annotations ?? []) {
            if (a.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title });
          }
        }
      }
    }
    if (j.status === 'incomplete') log.warn(`${model} の調査結果が途中切れ（${j.incomplete_details?.reason ?? '不明'}）`);
    return {
      text, sources, citations, toolCalls, model,
      usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
    };
  }

  /**
   * 1回呼ぶ。候補モデルが使えないときは kind='model_unavailable' で投げる。
   * ★textTimeoutMs（180秒）で打ち切る。時間切れは kind='timeout'・recoverable（structured の再試行の上限内でやり直す）。
   *   本文の受け取り中も時間切れの対象。候補の切替はしない（次のモデルでも待つだけになりうるため）
   */
  private async callOnce(model: string, system: string, user: string, maxTokens: number): Promise<{ text: string; usage: LlmUsage }> {
    const signal = AbortSignal.timeout(this.textTimeoutMs);
    const timeoutError = (e: unknown) => new LlmError(`timeout after ${this.textTimeoutMs}ms: ${String(e)}`,
      'OpenAI の応答に時間がかかりすぎたため、打ち切りました。', true, 0, 'timeout');
    let res: Response;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model,
          instructions: system,
          input: ensureJsonWord(user),
          max_output_tokens: maxTokens + REASONING_HEADROOM,
          store: false, // 理由は webResearch と同じ（保存済みの応答を残さない）
          text: { format: { type: 'json_object' } },
        }),
        signal,
      });
    } catch (e) {
      if (isAbort(e) || signal.aborted) throw timeoutError(e);
      throw new LlmError(String(e), '記事の生成中に通信エラーが発生しました。', true, 0, 'temp');
    }

    let raw: string;
    try { raw = await res.text(); } catch (e) {
      if (isAbort(e) || signal.aborted) throw timeoutError(e);
      throw new LlmError(String(e), '記事の生成中に通信エラーが発生しました。', true, res.status, 'temp');
    }
    if (!res.ok) throw classify(res.status, raw, model);

    let j: ResponsesBody;
    try { j = JSON.parse(raw) as ResponsesBody; } catch {
      throw new LlmError('応答が JSON でない', '記事の生成中にエラーが発生しました。', true, res.status, 'temp');
    }
    const text = (j.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    if (j.status === 'incomplete') {
      // 上限に届いて途中で切れた。呼び出し側の再試行に任せる
      log.warn(`${model} の出力が上限で途中切れ（${j.incomplete_details?.reason ?? '不明'}）`);
    }
    return {
      text,
      usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
    };
  }

  /** 候補を順に試す。使えなかったモデルだけ飛ばし、ほかの失敗はそのまま投げる。 */
  private async call(tier: ModelTier, system: string, user: string, maxTokens: number) {
    const { out } = await this.withCandidates(tier, (model) => this.callOnce(model, system, user, maxTokens));
    return out;
  }

  /** 候補の並びで fn を試す（文章生成と調査で共通） */
  private async withCandidates<R>(tier: CandidateKey, fn: (model: string) => Promise<R>): Promise<{ model: string; out: R }> {
    const list = this.working[tier]
      ? [this.working[tier]!, ...this.candidates[tier].filter((m) => m !== this.working[tier])]
      : this.candidates[tier];
    let lastUnavailable: LlmError | null = null;
    for (const model of list) {
      try {
        const out = await fn(model);
        this.working[tier] = model;
        return { model, out };
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'model_unavailable') {
          log.warn(`モデル ${model} は使えないため、次の候補へ進みます`);
          lastUnavailable = e;
          if (this.working[tier] === model) delete this.working[tier];
          continue;
        }
        throw e;
      }
    }
    throw new LlmError(lastUnavailable?.message ?? '使えるモデルがありません',
      'OpenAI の文章モデルが、どの候補も使えない状態です。\n' +
      'OpenAI 側でモデルが入れ替わった可能性があります。提供元（運用側）へご連絡ください。\n' +
      '書きかけの内容は残っています。', false, lastUnavailable?.status, 'model_unavailable');
  }

  /**
   * 画像を見て答える（サムネの検品）。Responses API の input_image で画像を渡す。
   *
   * ★再試行しない（1回呼ぶごとに課金される。検品できなかったら呼び出し側が「未検品」で画像を採用する）。
   * ★候補は light → heavy の順。画像を受け付けないモデルは次の候補へ進む（課金されない）。
   * ★store: false（顧客の画像を「保存済みの応答」として残さない）。画像・本文はログに出さない。
   * ★tier は受け取るが、候補の並びは vision 用（light → heavy）を使う。
   */
  async vision<T>(opts: VisionOptions<T>): Promise<LlmResult<T>> {
    const content = [
      { type: 'input_text', text: ensureJsonWord(opts.user) },
      ...opts.images.map((img) => ({
        type: 'input_image',
        image_url: `data:${img.mime};base64,${bytesToBase64(img.bytes)}`,
        // 題名の文字を読むので細かく見る
        detail: 'high',
      })),
    ];
    const body = {
      instructions: `${opts.system}\n\n必ず JSON オブジェクトのみを出力してください。前置き・説明・コードフェンスは一切不要です。`,
      input: [{ role: 'user', content }],
      max_output_tokens: (opts.maxTokens ?? 1500) + REASONING_HEADROOM,
      store: false,
      text: { format: { type: 'json_object' } },
    };
    const { out: j } = await this.withCandidates('vision', async (model) => {
      try {
        return await this.post(model, body, this.visionTimeoutMs);
      } catch (e) {
        // 画像の入力に対応していないモデル → 次の候補へ（このモデルでは課金されない）
        if (e instanceof LlmError && e.status === 400 && e.kind !== 'model_unavailable' && /image/i.test(e.message)) {
          throw new LlmError(`${model}: ${e.message}`, 'OpenAI のモデルが画像を受け付けません。', false, 400, 'model_unavailable');
        }
        throw e;
      }
    });
    const text = (j.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    const usage = { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    const parsed = opts.schema.safeParse(extractJson(text));
    if (!parsed.success) {
      throw new LlmError(`${opts.label}: 出力の形が不正`, '画像の確認に失敗しました。', false, undefined, 'bad_output');
    }
    return { data: parsed.data, usage };
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<LlmResult<T>> {
    const maxRetries = opts.maxRetries ?? DEFAULT_STRUCTURED_MAX_RETRIES;
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const user = attempt === 0
        ? opts.user
        : `${opts.user}\n\n【前回の出力が不正でした】${lastError}\nJSON のみを出力してください。`;
      let out: { text: string; usage: LlmUsage };
      try {
        out = await this.call(
          opts.tier,
          `${withAddendum(opts.label, opts.system)}\n\n必ず JSON オブジェクトのみを出力してください。前置き・説明・コードフェンスは一切不要です。`,
          user,
          opts.maxTokens ?? 8000,
        );
      } catch (e) {
        // 一時的なエラー（混雑・障害・通信）は待って再試行。キー不正や残高不足は待っても直らないのでそのまま投げる
        if (e instanceof LlmError && e.recoverable && attempt < maxRetries) {
          const waitMs = 2000 * Math.pow(2, attempt);
          log.warn(`${opts.label} が一時エラー（HTTP ${e.status}）。${waitMs / 1000}秒後に再試行します`);
          await sleep(waitMs);
          continue;
        }
        throw e;
      }
      usage.inputTokens += out.usage.inputTokens;
      usage.outputTokens += out.usage.outputTokens;

      const parsed = opts.schema.safeParse(extractJson(out.text));
      if (parsed.success) return { data: parsed.data, usage };
      lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ');
      log.warn(`${opts.label} の出力検証に失敗（${attempt + 1}/${maxRetries + 1}回目）`, lastError);
    }
    throw new LlmError(`${opts.label}: スキーマ検証に${maxRetries + 1}回失敗 — ${lastError}`,
      '記事の生成に失敗しました。もう一度お試しください。', true, undefined, 'bad_output');
  }
}

function classify(status: number, body: string, model: string): LlmError {
  let code = '', msg = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { error?: { code?: string; message?: string; type?: string } };
    code = `${j.error?.code ?? ''} ${j.error?.type ?? ''}`;
    msg = j.error?.message ?? msg;
  } catch { /* 本文が JSON でない */ }
  const hay = `${code} ${msg}`.toLowerCase();

  if (status === 401) {
    return new LlmError(msg, 'OpenAI の API キーが無効です。platform.openai.com でご確認ください。', false, status, 'auth');
  }
  if (hay.includes('insufficient_quota') || hay.includes('billing') || hay.includes('exceeded your current quota')) {
    return new LlmError(msg,
      'OpenAI の残高または利用上限に達しています。記事を作るには、先にクレジットのチャージが必要です。\n\n'
      + '▼ チャージはこちら\nhttps://platform.openai.com/settings/organization/billing/overview\n\n'
      + '「Add to credit balance」から購入できます（最低5ドルから）。\n'
      + '購入後、もう一度お試しください。書きかけの内容は残っています。',
      false, status, 'billing');
  }
  // モデルが存在しない・権限がない・使えない（次の候補へ進む）
  if (status === 404 || ((status === 400 || status === 403) && /model/.test(hay)
    && /(not found|does not exist|not supported|not have access|unsupported|deprecated|decommission|invalid model)/.test(hay))) {
    return new LlmError(`${model}: ${msg}`, 'OpenAI のモデルが使えません。', false, status, 'model_unavailable');
  }
  if (status === 429) {
    return new LlmError(msg, 'OpenAI が混み合っています。しばらくしてから自動で再試行します。', true, status, 'rate');
  }
  if (status >= 500) {
    return new LlmError(msg, 'OpenAI 側で一時的な障害が起きています。自動で再試行します。', true, status, 'temp');
  }
  return new LlmError(msg, '記事の生成中にエラーが発生しました。', false, status, 'other');
}

/**
 * Claude 呼び出し。
 *
 * @anthropic-ai/sdk は Workers でのバンドルに問題があり（beta/vaults の解決に失敗）、
 * 使うのは messages.create だけなので fetch で直接呼ぶ。LINE クライアントと同じ方針。
 *
 * ★BYOK: API キーはテナントごとに違うので、リクエストごとにインスタンスを作る。
 * ★モデルは用途で使い分ける（運用側の判断 2026-08-28）:
 *     本文生成などの重い処理 = Sonnet 5
 *     意図分類などの軽い処理 = Haiku 4.5
 */
import type { z } from 'zod';
import { log } from '../../lib/mask';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export const MODELS = {
  /** 記事の構成・本文・仕上げ。1本あたり約34円 */
  heavy: 'claude-sonnet-5',
  /** 修正指示の意図分類など。1回あたり1円未満 */
  light: 'claude-haiku-4-5-20251001',
} as const;

export type ModelTier = keyof typeof MODELS;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    /** 時間をおけば直る種類か（レート制限・一時障害・通信エラー） */
    readonly recoverable: boolean,
    /** 原因追跡用。ログに残す */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicLlm {
  /**
   * @param workspaceId ワークスペースに紐づいたAPIキー（identity-linked key）を使う場合に必須。
   *   Console の Settings → Workspaces で確認できる `wrkspc_` で始まるID。
   *   通常のキーなら不要。
   */
  /** 実際にヘッダへ載せるワークスペースID。形が違うものは載せない */
  private readonly workspaceId: string | null;

  constructor(private readonly apiKey: string, workspaceId?: string | null) {
    if (!apiKey?.startsWith('sk-ant-')) {
      throw new LlmError('APIキーの形式が不正',
        'Claude の API キーが正しく登録されていません。console.anthropic.com で発行したキー（sk-ant- で始まるもの）をご登録ください。', false);
    }

    // ★形の違うIDを送ると、Claude は 400 で全部断る。
    //   多くのキーはこのヘッダ無しでも通るので、**送らないほうが動く**。
    //   （2026-08-30 実地: 「wrkspc_」を付け忘れた値が入っていて、記事生成が全部失敗した）
    const trimmed = workspaceId?.trim() ?? '';
    if (trimmed && !trimmed.startsWith('wrkspc_')) {
      log.warn('ワークスペースIDの形が違うため、送らずに続行します（wrkspc_ で始まる必要があります）');
      this.workspaceId = null;
    } else {
      this.workspaceId = trimmed || null;
    }
  }

  private async call(model: string, system: string, user: string, maxTokens: number): Promise<MessagesResponse> {
    let res: Response;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': VERSION,
          'content-type': 'application/json',
          // ワークスペース紐づけキーの場合のみ必要
          ...(this.workspaceId ? { 'anthropic-workspace-id': this.workspaceId } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
    } catch (e) {
      throw new LlmError(String(e), '記事の生成中に通信エラーが発生しました。', true, 0);
    }

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) {
        throw new LlmError(body, 'Claude の API キーが無効です。console.anthropic.com でご確認ください。', false, res.status);
      }
      if (res.status === 429) {
        throw new LlmError(body, 'Claude 側が混み合っています。しばらくしてから自動で再試行します。', true, res.status);
      }
      if (res.status === 400 && /credit|billing/i.test(body)) {
        // ★どこで何をすれば復旧するかまで書く。「不足しています」だけだと顧客が動けない
        throw new LlmError(body,
          'Claude の残高が足りません。記事を作るには、先にクレジットを買い足す必要があります。\n\n'
          + '▼ チャージはこちら\n'
          + 'https://platform.claude.com/settings/billing\n\n'
          + '「Buy credits」から購入できます（最低5ドルから）。\n'
          + '購入後、もう一度お試しください。書きかけの内容は残っています。',
          false, res.status);
      }
      // BYOK で最も多い躓き。原因が分かる文言にしておく（サポート問い合わせを減らすため）
      // ★「送ったのに断られた」と「そもそも送っていない」を区別する。
      //   区別しないと、設定済みの人が設定画面を探し回ることになる（2026-08-30 実地）
      if (res.status === 400 && /workspace/i.test(body)) {
        throw new LlmError(body, this.workspaceId
          ? '登録されているワークスペースIDが正しくないようです。'
            + 'console.anthropic.com の Settings → Workspaces で、wrkspc_ から始まるIDをご確認ください。'
          // ★配備画面には入力欄が無い（必須項目を3つに絞ったため）。
          //   ダッシュボードから足せることまで書かないと、顧客は詰む
          : 'Claude の API キーがワークスペースに紐づいているため、ワークスペースIDの設定が必要です。\n'
            + '① console.anthropic.com の Settings → Workspaces で wrkspc_ から始まるIDを確認\n'
            + '② Cloudflare の画面 → お使いの Worker → 設定 → 変数とシークレット で\n'
            + '　 ANTHROPIC_WORKSPACE_ID として登録（ターミナルは不要です）',
          false, res.status);
      }
      if (res.status >= 500) {
        throw new LlmError(body, 'Claude 側で一時的な障害が起きています。自動で再試行します。', true, res.status);
      }
      throw new LlmError(
        body, '記事の生成中にエラーが発生しました。', false, res.status);
    }

    return res.json<MessagesResponse>();
  }

  /**
   * スキーマ付きで構造化出力を得る。
   * 検証に失敗したら最大 maxRetries 回だけ、そのステップを再試行する。
   */
  async structured<T>(opts: {
    tier: ModelTier;
    system: string;
    user: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
    maxRetries?: number;
    label: string;
  }): Promise<LlmResult<T>> {
    const maxRetries = opts.maxRetries ?? 2;
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const user = attempt === 0
        ? opts.user
        : `${opts.user}\n\n【前回の出力が不正でした】${lastError}\nJSON のみを出力してください。`;

      let res: MessagesResponse;
      try {
        res = await this.call(
          MODELS[opts.tier],
          `${opts.system}\n\n必ず JSON オブジェクトのみを出力してください。前置き・説明・コードフェンスは一切不要です。`,
          user,
          opts.maxTokens ?? 8000,
        );
      } catch (e) {
        // ★一時的なエラー（混雑・障害・通信）は、記事1本を丸ごと失敗させずに待って再試行する。
        //   キー不正や残高不足など、待っても直らないものはそのまま投げる。
        if (e instanceof LlmError && e.recoverable && attempt < maxRetries) {
          const waitMs = 2000 * Math.pow(2, attempt);
          log.warn(`${opts.label} が一時エラー（HTTP ${e.status}）。${waitMs / 1000}秒後に再試行します`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw e;
      }

      usage.inputTokens += res.usage.input_tokens;
      usage.outputTokens += res.usage.output_tokens;

      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      const parsed = opts.schema.safeParse(extractJson(text));
      if (parsed.success) return { data: parsed.data, usage };

      lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ');
      log.warn(`${opts.label} の出力検証に失敗（${attempt + 1}/${maxRetries + 1}回目）`, lastError);
    }

    throw new LlmError(`${opts.label}: スキーマ検証に${maxRetries + 1}回失敗 — ${lastError}`,
      '記事の生成に失敗しました。もう一度お試しください。', true);
  }
}

/** コードフェンスや前置きが混ざっても JSON を取り出す。 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

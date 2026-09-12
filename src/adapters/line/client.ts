/**
 * LINE Messaging API クライアント。
 *
 * ★通数の要点:
 *   Reply（応答メッセージ）は無料で**通数に数えられない** / Push は無料枠（月200通）を消費する。
 *   replyToken の寿命は約1分なので、記事生成（1〜3分）の完了通知は Push を使う。
 *   1記事あたり Push 1〜2通に抑えれば、無料プランで月100本前後まで回る。
 *
 * ★**枠を使い切っても、勝手に課金はされない**（無料プランは超えて送れない仕様）。
 *   起きるのは「届かなくなる」だけ。詳しくは core/line/quota.ts を参照。
 */
import { log } from '../../lib/mask';
import { recordPush, buildQuotaWarning, markLimitReached, takeLimitNotice } from '../../core/line/quota';

const API = 'https://api.line.me/v2/bot';
const CONTENT_API = 'https://api-data.line.me/v2/bot';

export interface LineMessage {
  type: 'text' | 'flex';
  [k: string]: unknown;
}

export class LineClient {
  /**
   * @param kv 渡すと、送った通数を数えて上限が近いことを知らせる。
   *   ★数えるのはプッシュだけ（返信は無料で通数に含まれない）。
   *   渡さなくても送信は普通にできる（数えないだけ）。
   */
  constructor(
    private readonly accessToken: string,
    private readonly kv?: KVNamespace,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /** @returns 通ったかどうかと、断られた理由（呼び出し側が見分けたいことがある） */
  private async call(path: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, detail: '' };

    const detail = await res.text();
    log.warn(`LINE API 失敗 ${path}`, { status: res.status, body: detail.slice(0, 300) });
    // 通知の失敗で本処理を落とさない（記事は投稿済みかもしれない）
    return { ok: false, detail };
  }

  /**
   * 応答メッセージ。無料で、通数にも数えられない。
   *
   * ★上限に達したことを伝えられるのは、ここだけ。
   *   プッシュが通らなくなっているのだから、知らせもプッシュでは届かない。
   *   ★**先頭に足す**（末尾に足すと、最後のメッセージのボタンが消える）。
   */
  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    const out = messages.slice(0, 5);
    if (this.kv && out.length < 5) {
      const notice = await takeLimitNotice(this.kv).catch(() => null);
      if (notice) out.unshift(text(notice));
    }
    await this.call('/message/reply', { replyToken, messages: out });
  }

  /** プッシュメッセージ。無料枠を消費するので必要最小限に。 */
  async push(to: string, messages: LineMessage[]): Promise<void> {
    const res = await this.call('/message/push', { to, messages: messages.slice(0, 5) });

    // ★数えるのは届いたぶんだけ。断られたものを数えると、実態からずれていく
    if (res.ok) { await this.countAndWarn(to); return; }

    // ★「今月はもう送れない」は LINE が教えてくれる。こちらの数え上げより確かなので、そちらを信じる
    if (this.kv && /monthly limit/i.test(res.detail)) {
      await markLimitReached(this.kv);
      log.info('LINE の無料通数を使い切りました（次の返信でお知らせします）');
    }
  }

  /**
   * 通数を数えて、区切りを越えたら知らせる。
   * ★知らせる行為でも1通使うが、それを数えると際限がないので数えない。
   * ★数える処理でこけても、本来の送信は成功しているので握りつぶす。
   */
  private async countAndWarn(to: string): Promise<void> {
    if (!this.kv) return;
    try {
      const { total, crossed } = await recordPush(this.kv);
      if (crossed === null) return;
      await this.call('/message/push', {
        to, messages: [{ type: 'text', text: buildQuotaWarning(total, crossed) }],
      });
      log.info('通数の警告を送りました', { total, crossed });
    } catch (e) {
      log.warn('通数の確認に失敗しました', String(e));
    }
  }

  /** ローディングアニメーション（生成中であることを伝える。無料）。 */
  async showLoading(userId: string, seconds = 60): Promise<void> {
    await this.call('/chat/loading/start', {
      chatId: userId,
      loadingSeconds: Math.min(60, Math.max(5, Math.round(seconds / 5) * 5)),
    });
  }

  /**
   * 表示名を取る（友だちになっている人だけ取れる）。
   * ★取れなくても処理は止めない。持ち主への「誰を登録したか」の知らせに使うだけ。
   */
  async getProfile(userId: string): Promise<{ displayName: string } | null> {
    try {
      const res = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) return null;
      const body = await res.json() as { displayName?: string };
      return body.displayName ? { displayName: body.displayName } : null;
    } catch {
      return null;
    }
  }

  /** 送られてきた画像の実体を取得する。 */
  async getContent(messageId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await fetch(`${CONTENT_API}/message/${encodeURIComponent(messageId)}/content`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) throw new Error(`LINE 画像取得に失敗しました (HTTP ${res.status})`);
    return {
      bytes: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'image/jpeg',
    };
  }
}

/** 簡単なテキストメッセージ。 */
export function text(t: string): LineMessage {
  return { type: 'text', text: t.slice(0, 4900) };
}

/** ボタン付きのテキスト（Quick Reply）。 */
export function textWithActions(
  t: string,
  actions: Array<{ label: string; data: string }>,
): LineMessage {
  return {
    type: 'text',
    text: t.slice(0, 4900),
    quickReply: {
      items: actions.slice(0, 13).map((a) => ({
        type: 'action',
        action: { type: 'postback', label: a.label.slice(0, 20), data: a.data, displayText: a.label },
      })),
    },
  };
}

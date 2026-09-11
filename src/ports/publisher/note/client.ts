/**
 * note 内部 API クライアント。
 *
 * 仕様はすべて Phase 0 の実機検証で確定させたもの（docs/phase0-findings.md）。
 * note は公式 API を提供していないため、この実装はいつか壊れる前提で書く。
 * ★壊れたときに触るファイルをここ1枚に閉じ込めること。
 */
import { log, mask } from '../../../lib/mask';

export const NOTE_API = 'https://note.com/api';

export interface NoteSession {
  /** DevTools からコピーした Cookie ヘッダそのもの */
  cookieHeader: string;
  /** Cookie を取得したブラウザの User-Agent（Cookie とセットで固定して使う） */
  userAgent: string;
  /** 投稿先アカウント名（公開URLの組み立てに使う） */
  urlname: string;
}

export interface CreatedNote {
  id: number;
  key: string;
  slug: string;
  canPublish: boolean;
}

/** note API が返すエラーをドメインの言葉に翻訳する。 */
export class NoteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 顧客にそのまま見せてよい日本語 */
    readonly userMessage: string,
    /** セッション切れなど、時間をおけば復帰しうるか */
    readonly recoverable: boolean = false,
  ) {
    super(`note API エラー [${status}/${code}] ${userMessage}`);
    this.name = 'NoteApiError';
  }
}

/** note のエラーコードを顧客向けメッセージに変換する。 */
function translateError(status: number, code: string, message: string): NoteApiError {
  switch (code) {
    case 'email_activation':
      return new NoteApiError(status, code,
        'note のメール認証が完了していません。note に登録したメールアドレスに届いている確認メールから認証を済ませてください。', true);
    case 'auth':
      return new NoteApiError(status, code,
        'note との連携が切れています。再接続をお願いします。', true);
    default:
      if (status === 401 || status === 403) {
        return new NoteApiError(status, code || 'unauthorized',
          'note との連携が切れています。再接続をお願いします。', true);
      }
      if (status === 429) {
        return new NoteApiError(status, code || 'rate_limited',
          'note 側が混み合っています。しばらくしてから自動で再試行します。', true);
      }
      return new NoteApiError(status, code || 'unknown',
        `note への投稿に失敗しました（${message || status}）`, false);
  }
}

export class NoteClient {
  /**
   * note がリクエストのたびに Set-Cookie でセッションを再発行するため、
   * 最新の Cookie をここに保持する。呼び出し側は publish 後に
   * `latestCookieHeader` を保存し直すこと（寿命を無駄に縮めないため）。
   */
  private cookieHeader: string;

  constructor(private readonly session: NoteSession) {
    this.cookieHeader = session.cookieHeader;
  }

  get latestCookieHeader(): string {
    return this.cookieHeader;
  }

  /**
   * 共通ヘッダ。
   * ★Phase 0 実測: CSRF ヘッダ（X-XSRF-TOKEN）は現行 note では不要。
   *   XSRF-TOKEN Cookie 自体が存在しない。
   */
  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Cookie: this.cookieHeader,
      Origin: 'https://note.com',
      Referer: 'https://editor.note.com/',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': this.session.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ja,en;q=0.9',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** Set-Cookie で返ってきた新しいセッションを取り込む。 */
  private absorbCookies(res: Response): void {
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length === 0) return;
    const jar = new Map<string, string>();
    for (const part of this.cookieHeader.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    for (const c of set) {
      const first = c.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
    this.cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private async request<T = any>(
    label: string, path: string, init: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(`${NOTE_API}${path}`, init);
    this.absorbCookies(res);

    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* HTML が返ることがある */ }

    if (!res.ok || json?.error) {
      const code = json?.error?.code ?? '';
      const message = json?.error?.message ?? text.slice(0, 200);
      log.warn(`note.${label} 失敗`, { status: res.status, code, message });
      throw translateError(res.status, code, message);
    }
    return (json?.data ?? json) as T;
  }

  /** ログイン状態の確認。セッションの生存チェックに使う。 */
  async currentUser(): Promise<{ id: number; urlname: string; nickname: string }> {
    return this.request('currentUser', '/v2/current_user', { headers: this.headers(false) });
  }

  /** 記事の器を作る。以降の操作に使う id と key を得る。 */
  async createNote(): Promise<CreatedNote> {
    const d = await this.request<any>('createNote', '/v1/text_notes', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ template_key: null }),
    });
    return { id: d.id, key: d.key, slug: d.slug, canPublish: d.can_publish !== false };
  }

  /**
   * 下書き保存。
   * ★本文フィールドは `body`（公開時の `free_body` と違うので注意）。
   * ★owner_urlname は自分の記事に付けてはいけない（auth エラーになる）。
   */
  async saveDraft(noteId: number, opts: { title: string; html: string; bodyLength: number }): Promise<void> {
    await this.request('saveDraft',
      `/v1/text_notes/draft_save?id=${encodeURIComponent(noteId)}&is_temp_saved=true`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          name: opts.title,
          body: opts.html,
          body_length: opts.bodyLength,
          stock_photo_image_id: null,
          separator: null,
          index: null,
          index_location: null,
          is_lead_form: false,
        }),
      });
  }

  /**
   * 公開する。
   * ★本文フィールドは `free_body`。`body` を送ると 422「本文を入力してください」になる。
   * ★exclude_ai_learning_reward=true で、note の AI 学習提供をオプトアウトする
   *   （クライアントの記事が第三者の学習データに回らないようにするため既定で有効）。
   */
  async publish(noteId: number, noteKey: string, opts: {
    title: string;
    html: string;
    bodyLength: number;
    hashtags?: string[];
    notifyFollowers?: boolean;
    excludeAiLearning?: boolean;
  }): Promise<{ url: string }> {
    await this.request('publish', `/v1/text_notes/${encodeURIComponent(noteId)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({
        name: opts.title,
        free_body: opts.html,
        body_length: opts.bodyLength,
        status: 'published',
        slug: `slug-${noteKey}`,
        pay_body: '',
        price: 0,
        limited: false,
        is_refund: false,
        index: false,
        disable_comment: false,
        exclude_from_creator_top: false,
        exclude_ai_learning_reward: opts.excludeAiLearning ?? true,
        send_notifications_flag: opts.notifyFollowers ?? true,
        author_ids: [],
        hashtags: opts.hashtags ?? [],
        image_keys: [],
        magazine_ids: [],
        magazine_keys: [],
        circle_permissions: [],
        discount_campaigns: [],
        pro_coupon_keys: [],
        separator: null,
        lead_form: { is_active: false, consent_url: '' },
        line_add_friend: { is_active: false, keyword: '', add_friend_url: '' },
      }),
    });
    return { url: `https://note.com/${this.session.urlname}/n/${noteKey}` };
  }

  /**
   * 本文画像をアップロードする。
   * ★エディタの現行経路。事前調査にあった presigned_post ではない。
   * ★note_key ではなく note_id（数値）を文字列で送る。note_key だと 400。
   */
  async uploadImage(noteId: number, file: Blob, fileName: string): Promise<{ url: string; width: number }> {
    const form = new FormData();
    form.append('file', file, fileName);
    form.append('note_id', String(noteId));
    return this.request('uploadImage', '/v1/image_upload/text_note_picture', {
      method: 'POST',
      headers: this.headers(false), // multipart なので Content-Type は fetch に任せる
      body: form,
    });
  }

  /**
   * サムネイル（見出し画像）をアップロードする。note では eyecatch と呼ぶ。
   *
   * ★実測（2026-08-28）:
   *   ・エディタは width=1920 / height=1005 を固定で送っている
   *   ・アップロードした時点で記事に紐づくので、公開ペイロードに何も足す必要がない
   *   ・公開ページの og:image になる（SNSシェア時の画像）
   */
  async uploadEyecatch(noteId: number, file: Blob, fileName: string): Promise<{ url: string }> {
    const form = new FormData();
    form.append('note_id', String(noteId));
    form.append('file', file, fileName);
    form.append('width', '1920');
    form.append('height', '1005');
    return this.request('uploadEyecatch', '/v1/image_upload/note_eyecatch', {
      method: 'POST',
      headers: this.headers(false),
      body: form,
    });
  }

  /** サムネイルを外す。 */
  async deleteEyecatch(noteId: number): Promise<void> {
    await this.request('deleteEyecatch', '/v1/image_upload/note_eyecatch/delete', {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ note_id: noteId }),
    });
  }

  /**
   * 記事を削除する。
   * ★下書きと公開済みで経路が違う（実測）。片方が失敗したらもう片方を試す。
   */
  async deleteNote(noteId: number): Promise<void> {
    try {
      await this.request('deleteDraft',
        `/v1/text_notes/draft_delete?id=${encodeURIComponent(noteId)}`,
        { method: 'DELETE', headers: this.headers(false) });
    } catch {
      await this.request('deletePublished',
        `/v1/notes/${encodeURIComponent(noteId)}`,
        { method: 'DELETE', headers: this.headers(false) });
    }
  }

  /** 公開済み記事の一覧。バックアップ・検証に使う（下書きは取得できない）。 */
  async listPublished(): Promise<Array<{ id: number; key: string; name: string; body: string }>> {
    const d = await this.request<any>('listPublished',
      `/v2/creators/${encodeURIComponent(this.session.urlname)}/contents?kind=note&page=1`,
      { headers: this.headers(false) });
    return d.contents ?? [];
  }

  /** セッションが生きているか。落ちていても例外にせず false を返す。 */
  async isAlive(): Promise<boolean> {
    try {
      await this.currentUser();
      return true;
    } catch (e) {
      log.info('note セッション死活確認: 失効', mask(String(e)));
      return false;
    }
  }
}

/**
 * 「顧客のブラウザに何をさせるか」を組み立てる。
 *
 * ★note の仕様を知っているのはサーバー側だけにする。
 *   拡張機能はこの手順書を順に実行するだけ（extension/plan-runner.js）。
 *   note の内部APIが変わったら、直すのはこのファイルと
 *   ports/publisher/note/client.ts だけで済む。
 */
import type { Db, ArticleRow } from '../../ports/storage/db';
import type { ImageStore } from '../../ports/storage/images';
import { toNoteHtml, plainLength } from '../../ports/publisher/note/html';
import { fill, normalize } from '../article/placeholders';

export interface PlanFormField {
  name: string;
  /** 固定値（`{{変数}}` を含められる） */
  value?: string;
  /** 画像の実体。拡張が Worker から取りに来る（images.id） */
  asset?: string;
  fileName?: string;
}

export interface PlanStep {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** note のパス。`/api/` で始まるものだけを拡張が受け付ける */
  path: string;
  json?: unknown;
  form?: PlanFormField[];
  /** 応答から取り込む値（`{ note_id: 'id' }` → 以後 `{{note_id}}` で使える） */
  capture?: Record<string, string>;
}

export interface AgentPlan {
  version: 1;
  kind: 'publish' | 'draft';
  /** 最初から分かっている値（既存記事の更新など） */
  vars: Record<string, string | number>;
  steps: PlanStep[];
}

/** 画像URLは公開時まで分からないので、本文には差し込み用の目印を入れておく。 */
function imageUrlVar(slot: number): string {
  return `{{image${slot}_url}}`;
}

/**
 * 記事1本を note に載せるまでの手順を組み立てる。
 *
 * サーバーが直接叩く場合（core/article/service.ts）と同じ順序・同じ本文になるようにする。
 * ここがずれると「拡張だと崩れる」が起きる。
 */
export async function buildPlan(
  deps: { db: Db; images: ImageStore },
  article: ArticleRow,
  kind: 'publish' | 'draft',
): Promise<AgentPlan> {
  const steps: PlanStep[] = [];
  const vars: Record<string, string | number> = {};

  // 1. 記事の器。すでに note にあるなら作らない（同じURLのまま更新する）
  const isUpdate = Boolean(article.note_id && article.note_key);
  if (isUpdate) {
    vars.note_id = Number(article.note_id);
    vars.note_key = article.note_key!;
  } else {
    steps.push({
      id: 'create',
      method: 'POST',
      path: '/api/v1/text_notes',
      json: { template_key: null },
      capture: { note_id: 'id', note_key: 'key' },
    });
  }

  // 2. 本文の画像。アップロードして返ってきたURLを本文に差し込む
  const images = await deps.db.listImages(article.id);
  const urls: Record<number, string> = {};
  for (let i = 0; i < images.length; i++) {
    const slot = i + 1;
    urls[slot] = imageUrlVar(slot);
    steps.push({
      id: `image${slot}`,
      method: 'POST',
      path: '/api/v1/image_upload/text_note_picture',
      form: [
        { name: 'file', asset: images[i].id, fileName: `image${slot}.png` },
        { name: 'note_id', value: '{{note_id}}' },
      ],
      capture: { [`image${slot}_url`]: 'url' },
    });
  }

  // 3. サムネイル（見出し画像）。上げた時点で記事に紐づくので本文には出さない
  const eyecatch = await deps.db.getEyecatch(article.id);
  if (eyecatch) {
    steps.push({
      id: 'eyecatch',
      method: 'POST',
      path: '/api/v1/image_upload/note_eyecatch',
      form: [
        { name: 'note_id', value: '{{note_id}}' },
        { name: 'file', asset: eyecatch.id, fileName: 'eyecatch.png' },
        { name: 'width', value: '1920' },
        { name: 'height', value: '1005' },
      ],
    });
  }

  // 4. 本文を組み立てる（画像URLは目印のまま。拡張が差し替える）
  const md = normalize(article.body_md ?? '', images.length);
  const alts: Record<string, string> = article.image_alts_json ? JSON.parse(article.image_alts_json) : {};
  const html = toNoteHtml(fill(md, urls, alts));
  const title = article.title ?? '無題';
  // ★目印は差し替え後も本文の見た目の長さを変えない（タグの中身なので数に入らない）
  const bodyLength = plainLength(html);

  // 5. 下書き保存。★本文フィールドは `body`（公開時の `free_body` と違う）
  steps.push({
    id: 'draft_save',
    method: 'POST',
    path: '/api/v1/text_notes/draft_save?id={{note_id}}&is_temp_saved=true',
    json: {
      name: title,
      body: html,
      body_length: bodyLength,
      stock_photo_image_id: null,
      separator: null,
      index: null,
      index_location: null,
      is_lead_form: false,
    },
  });

  // 6. 公開。★本文フィールドは `free_body`。`body` だと 422 になる
  if (kind === 'publish') {
    const hashtags: string[] = article.hashtags_json ? JSON.parse(article.hashtags_json) : [];
    steps.push({
      id: 'publish',
      method: 'PUT',
      path: '/api/v1/text_notes/{{note_id}}',
      json: {
        name: title,
        free_body: html,
        body_length: bodyLength,
        status: 'published',
        slug: 'slug-{{note_key}}',
        pay_body: '',
        price: 0,
        limited: false,
        is_refund: false,
        index: false,
        disable_comment: false,
        exclude_from_creator_top: false,
        // クライアントの記事を第三者のAI学習に回さない
        exclude_ai_learning_reward: true,
        send_notifications_flag: true,
        author_ids: [],
        hashtags,
        image_keys: [],
        magazine_ids: [],
        magazine_keys: [],
        circle_permissions: [],
        discount_campaigns: [],
        pro_coupon_keys: [],
        separator: null,
        lead_form: { is_active: false, consent_url: '' },
        line_add_friend: { is_active: false, keyword: '', add_friend_url: '' },
      },
    });
  }

  return { version: 1, kind, vars, steps };
}

/** 手順の中で使う画像（拡張が取りに来てよいもの）を列挙する。 */
export function planAssetIds(plan: AgentPlan): string[] {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    for (const field of step.form ?? []) {
      if (field.asset) ids.add(field.asset);
    }
  }
  return [...ids];
}

/**
 * リッチメニューの出し分け。
 *
 * ★狙い（2026-08-31 運用側の判断）:
 *   セットアップ中は「セットアップ」「note連携」の2つだけ出す。
 *   note と繋がったら、通常の3ボタンへ**自動で**切り替える。
 *   顧客に文字を打たせない（打ち間違いを無くす）ため。
 *
 * ★連携が切れたら、セットアップ用に**戻す**。
 *   note のログインは30日ほどで切れる。そのとき「note連携」ボタンが無いと、
 *   顧客は毎回手で打つことになる。押すだけで復旧できる状態を保つ。
 *
 * ★作ったメニューのIDは KV に覚えておく。
 *   切り替えのたびに作り直すと、LINE 側にゴミが溜まり、
 *   画像のアップロードで無駄に時間もかかる。
 */
import NORMAL_MENU from '../../../assets/richmenu.json';
import SETUP_MENU from '../../../assets/richmenu-setup.json';
import { log } from '../../lib/mask';

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

/** 画像の取得先。配布リポジトリは Public なので鍵なしで読める */
const RAW = 'https://raw.githubusercontent.com/e-pei/note-line-poster-template/main/assets';

export type MenuKind = 'setup' | 'normal';

interface MenuSpec {
  definition: unknown;
  imageUrl: string;
  /** 片付けの目印。この名前のものだけを消す */
  name: string;
}

const SPECS: Record<MenuKind, MenuSpec> = {
  setup: { definition: SETUP_MENU, imageUrl: `${RAW}/richmenu-setup.png`, name: SETUP_MENU.name },
  normal: { definition: NORMAL_MENU, imageUrl: `${RAW}/richmenu.png`, name: NORMAL_MENU.name },
};

const kvKey = (kind: MenuKind) => `richmenu:${kind}`;

async function call(
  token: string, method: string, path: string, body?: unknown,
  opts: { base?: string; contentType?: string } = {},
): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) {
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${opts.base ?? API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE API ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * メニューを1枚作って、IDを覚える。すでに覚えていれば作り直さない。
 *
 * @returns 作れなければ null（画像がまだ無い場合など）。**呼び出し側は止まらないこと。**
 */
export async function ensureMenu(
  token: string, kv: KVNamespace, kind: MenuKind,
): Promise<string | null> {
  const remembered = await kv.get(kvKey(kind)).catch(() => null);
  if (remembered) return remembered;

  const spec = SPECS[kind];

  let image: Uint8Array;
  try {
    const res = await fetch(spec.imageUrl);
    if (!res.ok) throw new Error(`画像を取得できません (${res.status})`);
    image = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    // ★画像がまだ用意されていないことがある（セットアップ用は後から追加した）。
    //   ここで例外を投げると、セットアップ全体が失敗してしまう
    log.warn('メニュー画像を取得できませんでした', { kind, detail: String(e) });
    return null;
  }

  if (image.length > 1024 * 1024) {
    log.warn('メニュー画像が 1MB を超えています', { kind });
    return null;
  }

  // 同じ名前の古いものを控えておき、新しいものを立ててから消す
  const { richmenus = [] } = await call(token, 'GET', '/richmenu/list');
  const old = richmenus.filter((m: { name?: string }) => m.name === spec.name);

  const created = await call(token, 'POST', '/richmenu', spec.definition);
  await call(token, 'POST', `/richmenu/${created.richMenuId}/content`, image,
    { base: DATA_API, contentType: 'image/png' });

  await kv.put(kvKey(kind), created.richMenuId);
  for (const m of old) await call(token, 'DELETE', `/richmenu/${m.richMenuId}`).catch(() => {});

  log.info('メニューを作成しました', { kind, cleaned: old.length });
  return created.richMenuId;
}

/**
 * 表示するメニューを切り替える。
 *
 * @returns 切り替えられたか。**失敗しても呼び出し側を止めないこと**
 *   （メニューが古いままでも、文字を打てば動く）。
 */
export async function switchTo(
  token: string, kv: KVNamespace, kind: MenuKind,
): Promise<boolean> {
  try {
    const id = await ensureMenu(token, kv, kind);
    if (!id) return false;
    await call(token, 'POST', `/user/all/richmenu/${id}`);
    log.info('メニューを切り替えました', { kind });
    return true;
  } catch (e) {
    log.warn('メニューの切り替えに失敗しました', { kind, detail: String(e) });
    return false;
  }
}

/** 覚えているIDを忘れる（作り直したいとき） */
export async function forgetMenus(kv: KVNamespace): Promise<void> {
  await Promise.all(([ 'setup', 'normal' ] as MenuKind[]).map((k) => kv.delete(kvKey(k)).catch(() => {})));
}

/** いま出すべきメニューはどちらか */
export function menuFor(noteConnected: boolean): MenuKind {
  return noteConnected ? 'normal' : 'setup';
}

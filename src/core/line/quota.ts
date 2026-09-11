/**
 * LINE の「送れる通数」を数えて、使いすぎる前に知らせる。
 *
 * ★なぜ要るか（2026-08-31 運用側の判断）:
 *   無料プラン（コミュニケーションプラン）は **1か月に200通**まで。
 *   気づかないまま上限に当たると、**プレビューも完成の知らせも届かなくなる**。
 *
 * ★**上限に達しても、勝手にお金は取られない**（2026-08-31 実確認・オーナー 指摘）。
 *   コミュニケーションプランとライトプランは、無料通数を超えて配信できない仕様。
 *   従量課金があるのはスタンダードプラン（月15,000円）だけ。
 *   つまり起きるのは「届かなくなる」であって「請求が増える」ではない。
 *   **「超過料金」と書かないこと。**顧客を無用に怖がらせる。
 *   出典: https://www.lycbiz.com/jp/service/line-official-account/plan/
 *
 * ★数えるのは「こちらから送るもの（プッシュ）」だけ。
 *   利用者の発言への返信は無料で、通数に含まれない。
 *
 * ★数え方はおおよそで構わない。
 *   目的は「請求を1円単位で当てること」ではなく「使いすぎに気づかせること」。
 *   多少ずれても、警告が出れば役目を果たす。
 */
import { log } from '../../lib/mask';

/** 無料プランで送れる通数（コミュニケーションプラン） */
export const FREE_LIMIT = 200;

/** ここを超えたら知らせる */
export const THRESHOLDS = [100, 150, 190] as const;

/** 月ごとに数える。JST で締める（利用者の感覚に合わせる） */
export function monthKey(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

const countKey = (month: string) => `linecount:${month}`;
const warnedKey = (month: string) => `linewarn:${month}`;
/** LINE から「今月はもう送れない」と言われた月 */
const reachedKey = (month: string) => `linefull:${month}`;
/** その事実を本人に伝え終えた月 */
const toldKey = (month: string) => `linefulltold:${month}`;

/** 30日ほど先で自然に消えるように（月をまたげば別のキーになる） */
const TTL = 45 * 24 * 60 * 60;

/**
 * 送った数を足して、越えた区切りがあれば返す。
 *
 * @returns 越えた区切り（100 / 150 / 190）。無ければ null
 */
export async function recordPush(
  kv: KVNamespace, sent = 1, now = new Date(),
): Promise<{ total: number; crossed: number | null }> {
  const month = monthKey(now);
  let before = 0;
  try {
    before = Number((await kv.get(countKey(month))) ?? 0) || 0;
  } catch (e) {
    // 数えられなくても送信は止めない
    log.warn('通数を読めませんでした', String(e));
    return { total: 0, crossed: null };
  }

  const total = before + sent;
  try {
    // 月をまたいだら自然に消えるよう、45日で期限切れにする
    await kv.put(countKey(month), String(total), { expirationTtl: TTL });
  } catch (e) {
    log.warn('通数を保存できませんでした', String(e));
    return { total, crossed: null };
  }

  // ★またいだ区切りのうち、いちばん大きいものだけを知らせる。
  //   1回の送信で複数またいでも、警告は1通で足りる
  const crossed = [...THRESHOLDS].reverse().find((t) => before < t && total >= t) ?? null;
  if (crossed === null) return { total, crossed: null };

  // 同じ区切りで何度も知らせない
  try {
    const warned = ((await kv.get(warnedKey(month))) ?? '').split(',').filter(Boolean);
    if (warned.includes(String(crossed))) return { total, crossed: null };
    await kv.put(warnedKey(month), [...warned, String(crossed)].join(','), { expirationTtl: TTL });
  } catch (e) {
    log.warn('警告の記録に失敗しました', String(e));
  }

  return { total, crossed };
}

/**
 * ★上限に当たったときに取れる道。
 *   ここでいちばん大事なのは「**放っておいても請求は来ない**」と伝えること。
 *   そのうえで、月5,000円を払う以外の道を先に並べる。
 */
const OPTIONS =
  '■ 選べる道\n'
  + '1. 来月まで待つ（何もしなくて構いません。翌月1日にまた200通に戻ります）\n'
  + '2. note の画面から直接投稿する\n'
  + '　 記事は LINE の「過去記事一覧」から全文を出せます。コピーして貼るだけです\n'
  + '3. LINE公式アカウントを月額プランに上げる\n'
  + '　 ライトプラン 月5,000円（税別）で、月5,000通まで送れるようになります\n'
  + '　 変更は LINE Official Account Manager（https://manager.line.biz/）から\n\n'
  + '多くの場合、月5,000円を払うより、当たった月だけ 2 で済ませるほうが現実的です。';

/** 知らせる文面。★何をすればいいかまで書く */
export function buildQuotaWarning(total: number, crossed: number): string {
  const rest = Math.max(FREE_LIMIT - total, 0);
  const head = crossed >= 190
    ? '⚠ LINE の無料通数が、まもなく上限です。'
    : 'LINE の無料通数のお知らせです。';

  return `${head}\n\n`
    + `今月の送信：${total} 通 / ${FREE_LIMIT} 通\n`
    + `残り：約 ${rest} 通\n\n`
    + '※ ここで数えているのは、システムから届く通知だけです。\n'
    + 'あなたの発言への返信は通数に含まれません。\n\n'
    + (crossed >= 190
      // ★190 は、こちらから送れる最後の機会。上限後に何が起きるかをここで全部言っておく
      //   （200 に達したあとは、こちらから知らせを送れない）
      ? '上限に達すると、記事のプレビューや完成のお知らせが届かなくなります。\n'
        + '※ 自動で料金が発生することはありません。届かなくなるだけです。\n\n'
        + '当たるまでに減らすなら、1本あたりの修正回数を減らすのがいちばん効きます。\n'
        + '（修正のたびにプレビューを送るので、そのぶん通数を使います）\n\n'
        + OPTIONS
      : '上限に達すると通知が届かなくなります。ペースの目安にしてください。');
}

/**
 * LINE が「今月はもう送れない」と断ってきたことを覚えておく。
 *
 * ★こちらの数え上げではなく、**LINE が実際に断ったこと**を根拠にする。
 *   数えた通数はずれることがあるが、断られた事実はずれない。
 */
export async function markLimitReached(kv: KVNamespace, now = new Date()): Promise<void> {
  try {
    await kv.put(reachedKey(monthKey(now)), new Date().toISOString(), { expirationTtl: TTL });
  } catch (e) {
    log.warn('上限に達したことを記録できませんでした', String(e));
  }
}

/**
 * 上限に達したことを、まだ伝えていなければ伝える文面を返す。
 *
 * ★**返信（無料）でしか届けられない。**上限に達したあとはプッシュが通らないため。
 *   なので「利用者が何か送ってきたとき」に、その返事へ足す形で使う。
 *
 * @returns 伝えるべき文面。伝える必要が無ければ null
 */
export async function takeLimitNotice(
  kv: KVNamespace, now = new Date(),
): Promise<string | null> {
  const month = monthKey(now);
  try {
    if (!(await kv.get(reachedKey(month)))) return null;
    if (await kv.get(toldKey(month))) return null;
    await kv.put(toldKey(month), new Date().toISOString(), { expirationTtl: TTL });
  } catch (e) {
    // ★読めないときは黙る。毎回同じ知らせを繰り返すより害が小さい
    log.warn('上限の通知状態を読めませんでした', String(e));
    return null;
  }
  return buildLimitReachedNotice();
}

/** 上限に達したときの文面。 */
export function buildLimitReachedNotice(): string {
  return 'LINE の無料メッセージが、今月の上限（200通）に達しました。\n\n'
    + 'このあと、記事のプレビューや完成のお知らせが届かなくなります。\n'
    + '※ 自動で料金が発生することはありません。届かなくなるだけです。\n'
    + '※ いまお読みのような「あなたの発言への返信」は、これまでどおり届きます。\n'
    + '　 記事を作る・修正する・公開する操作そのものは、いままでどおり行えます。\n\n'
    + OPTIONS;
}

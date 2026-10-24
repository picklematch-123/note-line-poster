/**
 * Webリサーチの設定（顧客ごと＝環境ごと。system_flags に文字列で保存）。
 *
 * ★設定を変えられるのは持ち主だけ（費用に直結するため。判定は LINE の入口で行う）。
 * ★読めない値は「変えない」。危ない側（Webで調べる・上限なし）に倒さない。
 *   保存済みの値が壊れていたときも、既定（与えた情報だけ・指定なし・5件）として読む。
 * ★調べる先は固定の候補から選ぶだけ。自由入力は作らない（打ち間違いと、ドメイン欄への注入を防ぐ）。
 */
import type { Db } from '../../ports/storage/db';

export const FLAG_MODE = 'research_mode';
export const FLAG_DOMAINS = 'research_domains';
export const FLAG_DAILY_LIMIT = 'research_daily_limit';
/** 健康・医療・お金のテーマで「調べる先を限定しますか」を一度出したか */
export const FLAG_DOMAIN_HINT_SHOWN = 'research_domain_hint_shown';

/** none = 与えた情報だけで書く（既定） / web = Webで調べて出典つきで書く */
export type ResearchMode = 'none' | 'web';
export const RESEARCH_MODES: readonly ResearchMode[] = ['none', 'web'];
export const DEFAULT_MODE: ResearchMode = 'none';

/** 調べる先の候補。キーだけを保存し、ドメインの中身はコードの側に持つ */
export const DOMAIN_PRESETS = {
  any: { label: '指定なし', domains: [] as string[] },
  gov: { label: '官公庁（go.jp）', domains: ['go.jp'] },
  academic: { label: '医療・学術（ac.jp・nih.gov など）', domains: ['ac.jp', 'nih.gov', 'who.int'] },
  stats: { label: '統計（e-Stat など）', domains: ['e-stat.go.jp', 'stat.go.jp'] },
} as const;
export type DomainPreset = keyof typeof DOMAIN_PRESETS;
export const DOMAIN_PRESET_KEYS = Object.keys(DOMAIN_PRESETS) as DomainPreset[];
export const DEFAULT_DOMAINS: DomainPreset = 'any';

/** 1日に調べる記事数の選択肢。0（無制限）は用意しない */
export const DAILY_LIMIT_OPTIONS = [3, 5, 10] as const;
export const DEFAULT_DAILY_LIMIT = 5;

/** 1記事あたりの調査の回数（初回＋「もう一度調べる」2回）。費用の暴走を防ぐ */
export const MAX_RESEARCH_PER_ARTICLE = 3;
/** 1回の調査で検索ツールを呼んでよい回数（P0 実測: 1〜4回。費用の主役は読み込むトークン） */
export const MAX_TOOL_CALLS = 3;

export interface ResearchSettings {
  mode: ResearchMode;
  domains: DomainPreset;
  dailyLimit: number;
}

export function parseMode(v: string | null | undefined): ResearchMode | null {
  return (RESEARCH_MODES as readonly string[]).includes(v ?? '') ? (v as ResearchMode) : null;
}

export function parseDomains(v: string | null | undefined): DomainPreset | null {
  return (DOMAIN_PRESET_KEYS as string[]).includes(v ?? '') ? (v as DomainPreset) : null;
}

export function parseDailyLimit(v: string | number | null | undefined): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return (DAILY_LIMIT_OPTIONS as readonly number[]).includes(n) ? n : null;
}

export async function getResearchSettings(db: Db): Promise<ResearchSettings> {
  return {
    mode: parseMode(await db.getTextFlag(FLAG_MODE)) ?? DEFAULT_MODE,
    domains: parseDomains(await db.getTextFlag(FLAG_DOMAINS)) ?? DEFAULT_DOMAINS,
    dailyLimit: parseDailyLimit(await db.getTextFlag(FLAG_DAILY_LIMIT)) ?? DEFAULT_DAILY_LIMIT,
  };
}

/** 保存する。読めない値なら何もせず false を返す（＝変更しない） */
export async function setResearchMode(db: Db, raw: string | null, by: string): Promise<boolean> {
  const v = parseMode(raw);
  if (!v) return false;
  await db.setTextFlag(FLAG_MODE, v, 'Webリサーチの調べ方', by);
  return true;
}

export async function setResearchDomains(db: Db, raw: string | null, by: string): Promise<boolean> {
  const v = parseDomains(raw);
  if (!v) return false;
  await db.setTextFlag(FLAG_DOMAINS, v, 'Webリサーチの調べる先', by);
  return true;
}

export async function setResearchDailyLimit(db: Db, raw: string | null, by: string): Promise<boolean> {
  const v = parseDailyLimit(raw);
  if (v === null) return false;
  await db.setTextFlag(FLAG_DAILY_LIMIT, String(v), 'Webリサーチの1日の上限', by);
  return true;
}

export function domainsOf(preset: DomainPreset): string[] {
  return [...DOMAIN_PRESETS[preset].domains];
}

/**
 * 健康・医療・お金のテーマか（ネタの文面だけで判定する簡易版）。
 * ★外しても害は小さい（案内が出ないだけ・強制はしない）ので、語の一覧で十分とする。
 */
const SENSITIVE_THEME = /(健康|医療|病気|病院|症状|治療|薬|サプリ|ダイエット|痩せ|腰痛|肩こり|血圧|血糖|がん|癌|妊娠|睡眠|メンタル|うつ|栄養|カロリー|お金|投資|株|資産|節税|税金|保険|年金|ローン|借金|副業|NISA|iDeCo|仮想通貨)/i;

export function isSensitiveTheme(text: string): boolean {
  return SENSITIVE_THEME.test(text);
}

/**
 * 「調べる先を限定しますか」を出すか。
 * Webで調べる設定で、調べる先が指定なしで、テーマが健康・医療・お金で、まだ一度も出していないときだけ。
 */
export function shouldSuggestDomains(theme: string, s: ResearchSettings, alreadyShown: boolean): boolean {
  return s.mode === 'web' && s.domains === 'any' && !alreadyShown && isSensitiveTheme(theme);
}

export const DOMAIN_HINT =
  '健康・医療・お金の話題は、調べる先を信頼できるサイト（官公庁・医療・学術など）に絞ることもできます。持ち主が「AI設定」→「調べる先」から選べます（強制ではありません）。';

/** LINE の「AI設定」から来る保存の操作 */
export type ResearchSettingAction = 'ai_mode' | 'ai_domains_set' | 'ai_rlimit_set';
export type ApplyResult = 'saved' | 'denied' | 'no_key' | 'ignored';

/**
 * 設定を1つ保存する（入口の判定をここに集める。LINE 以外の入口が増えても同じ判定を通す）。
 *   denied  = 持ち主ではない（費用に直結する設定なので持ち主だけ）
 *   no_key  = OpenAI のキーが無い環境（使えない機能を有効にしない）
 *   ignored = 読めない値・知らない操作（何も変えない）
 */
export async function applyResearchSetting(db: Db, req: {
  isOwner: boolean; hasKey: boolean; action: string; value: string | null; by: string;
}): Promise<ApplyResult> {
  if (!req.isOwner) return 'denied';
  if (!req.hasKey) return 'no_key';
  const ok = req.action === 'ai_mode' ? await setResearchMode(db, req.value, req.by)
    : req.action === 'ai_domains_set' ? await setResearchDomains(db, req.value, req.by)
    : req.action === 'ai_rlimit_set' ? await setResearchDailyLimit(db, req.value, req.by)
    : false;
  return ok ? 'saved' : 'ignored';
}

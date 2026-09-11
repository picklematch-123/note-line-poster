import { describe, it, expect } from 'vitest';
import {
  extractUrls, buildContextSnippet, ensureContextUrls,
  listEntries, removeEntry, RAW_PASSTHROUGH_LIMIT,
} from '../../src/core/generation/context';

// プロフィールは LLM が300字に要約するので、URL や「必ず〜すること」は落ちる。
// ここは LLM を通さず原文から拾い直す部分なので、落ちないことを固定しておく。

describe('URL の拾い出し', () => {
  it('文中の URL を拾う', () => {
    expect(extractUrls('予約は https://example.com/shop からどうぞ'))
      .toEqual(['https://example.com/shop']);
  });

  it('句読点や括弧を巻き込まない', () => {
    expect(extractUrls('https://example.com/a。')).toEqual(['https://example.com/a']);
    expect(extractUrls('https://example.com/a、')).toEqual(['https://example.com/a']);
    expect(extractUrls('（https://example.com/a）')).toEqual(['https://example.com/a']);
    expect(extractUrls('(https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(extractUrls('https://example.com/a.')).toEqual(['https://example.com/a']);
  });

  it('複数あれば書かれた順に返す', () => {
    expect(extractUrls('店 https://a.example.com と 予約 https://b.example.com'))
      .toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('同じ URL は1回だけ', () => {
    expect(extractUrls('https://a.example.com と https://a.example.com'))
      .toEqual(['https://a.example.com']);
  });

  it('URL が無ければ空', () => {
    expect(extractUrls('焼き鳥屋を経営しています')).toEqual([]);
  });

  it('スキームだけの文字列は拾わない', () => {
    expect(extractUrls('https:// と書いただけ')).toEqual([]);
  });

  it('クエリ付きでも切らない', () => {
    expect(extractUrls('https://example.com/p?a=1&b=2 を見て'))
      .toEqual(['https://example.com/p?a=1&b=2']);
  });
});

describe('生成プロンプトに差し込む前提条件', () => {
  const analyzed = {
    digest: 'あなたは福岡で焼き鳥屋を営んでいます。20〜40代の常連に向けて書きます。',
    rules: ['記事の文末に自社サイトのリンクを貼ること'],
    avoid: ['他店の批判'],
  };

  it('整理した内容をそのまま残す', () => {
    expect(buildContextSnippet('焼き鳥屋です', analyzed)).toContain(analyzed.digest);
  });

  it('★本人が書いたルールを原文のまま載せる', () => {
    const out = buildContextSnippet('焼き鳥屋です', analyzed);
    expect(out).toContain('記事の文末に自社サイトのリンクを貼ること');
    expect(out).toContain('必ず守ること');
  });

  it('書いてほしくないことも載せる', () => {
    expect(buildContextSnippet('焼き鳥屋です', analyzed)).toContain('他店の批判（書かない）');
  });

  it('★要約が URL を落としても、原文から拾い直して載せる', () => {
    const raw = '福岡の焼き鳥屋です。記事の文末に必ず https://example.com/shop のリンクを貼ってください。';
    // 要約側からは URL が消えている、という最悪の場合を再現する
    const out = buildContextSnippet(raw, { digest: 'あなたは焼き鳥屋を営んでいます。', rules: [] });
    expect(out).toContain('https://example.com/shop');
  });

  it('★URL を変えさせない指示が付く', () => {
    const out = buildContextSnippet('店は https://example.com/shop です', analyzed);
    expect(out).toContain('一字一句');
    expect(out).toContain('作らない');
  });

  it('URL が無ければ URL の節は出さない', () => {
    const out = buildContextSnippet('焼き鳥屋です', analyzed);
    expect(out).not.toContain('記事で使うURL');
  });

  it('ルールも URL も無ければ、整理した内容と原文だけになる', () => {
    const out = buildContextSnippet('焼き鳥屋です', { digest: 'あなたは焼き鳥屋です。' });
    expect(out).toBe('あなたは焼き鳥屋です。\n\n【本人のメモ（原文）】\n焼き鳥屋です');
  });

  it('メモが空なら整理した内容だけになる', () => {
    expect(buildContextSnippet('', { digest: 'あなたは焼き鳥屋です。' })).toBe('あなたは焼き鳥屋です。');
  });

  it('空白だけのルールは載せない', () => {
    const out = buildContextSnippet('焼き鳥屋です', {
      digest: 'あなたは焼き鳥屋です。', rules: ['  ', ''], avoid: [],
    });
    expect(out).not.toContain('必ず守ること');
  });
});

describe('★登録済みプロフィールの取りこぼしを読み出し時に補う', () => {
  // すでに登録されているプロフィールは、URL が要約から落ちたまま保存されている。
  // 顧客に登録し直してもらわなくても効くように、読むたびに補う。
  const raw = '福岡の焼き鳥屋です。文末に必ず https://example.com/shop のリンクを貼ってください。';

  it('欠けている URL を足す', () => {
    const out = ensureContextUrls(raw, 'あなたは焼き鳥屋を営んでいます。');
    expect(out).toContain('https://example.com/shop');
    expect(out).toContain('あなたは焼き鳥屋を営んでいます。');
  });

  it('★何度通しても増えない', () => {
    const once = ensureContextUrls(raw, 'あなたは焼き鳥屋を営んでいます。')!;
    const twice = ensureContextUrls(raw, once)!;
    expect(twice).toBe(once);
    expect(twice.match(/https:\/\/example\.com\/shop/g)).toHaveLength(1);
  });

  it('すでに入っていれば何もしない', () => {
    const snippet = buildContextSnippet(raw, { digest: 'あなたは焼き鳥屋です。', rules: [] });
    expect(ensureContextUrls(raw, snippet)).toBe(snippet);
  });

  it('URL が無ければそのまま返す', () => {
    expect(ensureContextUrls('焼き鳥屋です', 'あなたは焼き鳥屋です。')).toBe('あなたは焼き鳥屋です。');
  });

  it('プロフィール未登録なら null のまま', () => {
    expect(ensureContextUrls(null, null)).toBeNull();
    expect(ensureContextUrls(raw, null)).toBeNull();
  });

  it('複数の URL のうち欠けているものだけ足す', () => {
    const two = '店 https://a.example.com と 予約 https://b.example.com';
    const out = ensureContextUrls(two, 'あなたは店主です。 https://a.example.com は掲載済み。')!;
    expect(out.match(/https:\/\/a\.example\.com/g)).toHaveLength(1);
    expect(out).toContain('https://b.example.com');
  });
});

describe('溜めたメモの出し入れ', () => {
  const raw = '福岡で焼き鳥屋をやっています。\n\n締めのデザートを増やしたい。\n\n店主は「大将」と書いてください。';

  it('空行区切りで1件ずつに分ける', () => {
    expect(listEntries(raw)).toEqual([
      '福岡で焼き鳥屋をやっています。',
      '締めのデザートを増やしたい。',
      '店主は「大将」と書いてください。',
    ]);
  });

  it('空行が続いても数え間違えない', () => {
    expect(listEntries('あ\n\n\n\nい\n\n')).toEqual(['あ', 'い']);
  });

  it('1件だけ消せる', () => {
    expect(listEntries(removeEntry(raw, 2))).toEqual([
      '福岡で焼き鳥屋をやっています。',
      '店主は「大将」と書いてください。',
    ]);
  });

  it('範囲外の番号では何も変えない', () => {
    expect(removeEntry(raw, 0)).toBe(raw);
    expect(removeEntry(raw, 99)).toBe(raw);
  });

  it('最後の1件を消すと空になる', () => {
    expect(removeEntry('ひとつだけ', 1)).toBe('');
  });
});

describe('★短いうちは原文をそのまま渡す', () => {
  // 要約は情報を落とす。落とさずに済むなら、そのほうが正確。
  const analyzed = { digest: 'あなたは焼き鳥屋を営んでいます。', rules: [], avoid: [] };

  it('短いメモは原文ごと差し込む', () => {
    const raw = '福岡で20席の焼き鳥屋。備長炭。締めに黒ごまアイスを出したい。';
    const out = buildContextSnippet(raw, analyzed);
    expect(out).toContain('【本人のメモ（原文）】');
    expect(out).toContain(raw);
  });

  it('長くなったら整理した内容だけにする', () => {
    const raw = 'あ'.repeat(RAW_PASSTHROUGH_LIMIT + 1);
    const out = buildContextSnippet(raw, analyzed);
    expect(out).not.toContain('【本人のメモ（原文）】');
    expect(out).toContain('あなたは焼き鳥屋を営んでいます。');
  });

  it('ちょうど上限なら原文を渡す（境界値）', () => {
    const raw = 'あ'.repeat(RAW_PASSTHROUGH_LIMIT);
    expect(buildContextSnippet(raw, analyzed)).toContain('【本人のメモ（原文）】');
  });

  it('★長くなっても、決まりごとと URL は必ず残る', () => {
    const raw = 'あ'.repeat(RAW_PASSTHROUGH_LIMIT) + ' 予約は https://example.com/reserve から。';
    const out = buildContextSnippet(raw, {
      digest: 'あなたは焼き鳥屋です。',
      rules: ['文末にリンクを貼ること'],
    });
    expect(out).not.toContain('【本人のメモ（原文）】');
    expect(out).toContain('文末にリンクを貼ること');
    expect(out).toContain('https://example.com/reserve');
  });

  it('言い方の指定も差し込む', () => {
    const out = buildContextSnippet('店の話', {
      digest: 'あなたは焼き鳥屋です。',
      wording: ['店主は「大将」と書く'],
    });
    expect(out).toContain('【言い方の指定】');
    expect(out).toContain('店主は「大将」と書く');
  });
});

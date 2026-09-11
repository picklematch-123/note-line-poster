import { describe, it, expect } from 'vitest';
import { toNoteHtml, escapeHtml, inline, plainLength } from '../../src/ports/publisher/note/html';

describe('escapeHtml', () => {
  it('特殊文字を escape する', () => {
    expect(escapeHtml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });
});

describe('inline', () => {
  it('**太字** を strong にする', () => {
    expect(inline('これは**太字**です')).toBe('これは<strong>太字</strong>です');
  });

  it('[text](url) をリンクにする', () => {
    expect(inline('[note](https://note.com)')).toBe('<a href="https://note.com">note</a>');
  });

  it('figure はそのまま通す', () => {
    const f = '<figure><img src="https://x/a.png"></figure>';
    expect(inline(f)).toBe(f);
  });

  it('本文中の < > はエスケープされる', () => {
    expect(inline('a < b')).toBe('a &lt; b');
  });
});

describe('toNoteHtml', () => {
  it('見出しを h2/h3 にする', () => {
    expect(toNoteHtml('## 見出し2\n\n### 見出し3')).toBe('<h2>見出し2</h2><h3>見出し3</h3>');
  });

  it('段落を p にする', () => {
    expect(toNoteHtml('本文です。')).toBe('<p>本文です。</p>');
  });

  it('連続行は br でつなぐ', () => {
    expect(toNoteHtml('一行目\n二行目')).toBe('<p>一行目<br>二行目</p>');
  });

  it('箇条書きを ul/li にする', () => {
    expect(toNoteHtml('- あ\n- い')).toBe('<ul><li>あ</li><li>い</li></ul>');
  });

  it('番号リストを ol/li にする', () => {
    expect(toNoteHtml('1. あ\n2. い')).toBe('<ol><li>あ</li><li>い</li></ol>');
  });

  it('引用を blockquote にする', () => {
    expect(toNoteHtml('> 引用です')).toBe('<blockquote>引用です</blockquote>');
  });

  it('--- を hr にする', () => {
    expect(toNoteHtml('---')).toBe('<hr>');
  });

  it('figure（画像）をそのまま通す', () => {
    const md = '## 見出し\n\n<figure><img src="https://x/a.png"></figure>\n\n本文';
    const out = toNoteHtml(md);
    expect(out).toBe('<h2>見出し</h2><figure><img src="https://x/a.png"></figure><p>本文</p>');
  });

  it('Phase 0 で実証済みのタグ構成を再現できる', () => {
    const md = [
      'リード文。',
      '',
      '## 見出し1',
      '',
      '段落と**強調**。',
      '',
      '### 小見出し',
      '',
      '- 箇条書き1',
      '- 箇条書き2',
      '',
      '> 引用',
      '',
      '[リンク](https://example.com)',
    ].join('\n');
    const out = toNoteHtml(md);
    expect(out).toContain('<h2>見出し1</h2>');
    expect(out).toContain('<h3>小見出し</h3>');
    expect(out).toContain('<strong>強調</strong>');
    expect(out).toContain('<ul><li>箇条書き1</li><li>箇条書き2</li></ul>');
    expect(out).toContain('<blockquote>引用</blockquote>');
    expect(out).toContain('<a href="https://example.com">リンク</a>');
    // note が受け付けないタグが混ざっていないこと
    expect(out).not.toMatch(/<(div|span|h1|h4|table|script|code|pre)\b/);
  });

  it('空文字は空文字', () => {
    expect(toNoteHtml('')).toBe('');
  });
});

describe('plainLength', () => {
  it('タグを除いた文字数を数える', () => {
    expect(plainLength('<p>あいう</p>')).toBe(3);
    expect(plainLength('<h2>見出し</h2><p>本文</p>')).toBe(5);
  });
});

describe('★裸のURLの自動リンク化', () => {
  // note は API 経由で受け取った本文を自動リンク化しない。
  // プロフィールに「文末に自社サイトのリンクを貼る」と書いた顧客の URL が
  // ただの文字列のまま公開された（2026-08-29 運用側の判断）。
  const URL = 'https://example.com/shop';

  it('文中の URL をクリックできるリンクにする', () => {
    expect(inline(`詳しくは ${URL} をご覧ください`))
      .toBe(`詳しくは <a href="${URL}">${URL}</a> をご覧ください`);
  });

  it('句点が続いてもリンクに巻き込まない', () => {
    expect(inline(`ご予約は ${URL}。お待ちしています`))
      .toBe(`ご予約は <a href="${URL}">${URL}</a>。お待ちしています`);
  });

  it('読点・全角括弧が続いてもリンクに巻き込まない', () => {
    expect(inline(`${URL}、こちらです`)).toBe(`<a href="${URL}">${URL}</a>、こちらです`);
    expect(inline(`（${URL}）`)).toBe(`（<a href="${URL}">${URL}</a>）`);
  });

  it('半角の閉じ括弧やピリオドは URL から切り離す', () => {
    expect(inline(`(${URL})`)).toBe(`(<a href="${URL}">${URL}</a>)`);
    expect(inline(`${URL}.`)).toBe(`<a href="${URL}">${URL}</a>.`);
  });

  it('行末の URL もリンクになる', () => {
    expect(inline(URL)).toBe(`<a href="${URL}">${URL}</a>`);
  });

  it('1行に複数あっても全部リンクになる', () => {
    const out = inline(`${URL} と https://example.net/a を見てください`);
    expect(out).toContain(`<a href="${URL}">`);
    expect(out).toContain('<a href="https://example.net/a">');
  });

  it('★[text](url) 記法は二重にリンクしない', () => {
    expect(inline('[お店の紹介](https://example.com/shop)'))
      .toBe('<a href="https://example.com/shop">お店の紹介</a>');
  });

  it('★記法リンクと裸のURLが混ざっていても壊れない', () => {
    const out = inline(`[お店](${URL}) と ${URL} の両方`);
    expect(out).toBe(
      `<a href="${URL}">お店</a> と <a href="${URL}">${URL}</a> の両方`,
    );
    // <a> が入れ子になっていない
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out).not.toContain('<a href="<a');
  });

  it('リンクの表示文字列が URL でも二重にしない', () => {
    const out = inline(`[${URL}](${URL})`);
    expect(out).toBe(`<a href="${URL}">${URL}</a>`);
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('クエリ付きの URL を壊さない', () => {
    const out = inline('https://example.com/p?a=1&b=2 を参照');
    // & は escape 済み。href に入っても正しく & として解釈される
    expect(out).toBe('<a href="https://example.com/p?a=1&amp;b=2">https://example.com/p?a=1&amp;b=2</a> を参照');
  });

  it('スキームだけの文字列はリンクにしない', () => {
    expect(inline('https:// と書いただけ')).toBe('https:// と書いただけ');
  });

  it('URL でない文字列は変えない', () => {
    expect(inline('note.com が便利です')).toBe('note.com が便利です');
  });

  it('画像の figure 行には手を入れない', () => {
    const f = '<figure><img src="https://assets.st-note.com/a.png" alt="写真"></figure>';
    expect(inline(f)).toBe(f);
  });

  it('★画像の差し込み用の目印を壊さない（拡張が後で置換する）', () => {
    const f = '<figure><img src="{{image1_url}}" alt="写真"></figure>';
    expect(inline(f)).toBe(f);
  });

  it('箇条書きや見出しの中でもリンクになる', () => {
    const html = toNoteHtml(`## お問い合わせ\n\n- 予約: ${URL}\n\n文末は ${URL} です。`);
    expect(html).toContain('<h2>お問い合わせ</h2>');
    expect(html).toContain(`<li>予約: <a href="${URL}">${URL}</a></li>`);
    expect(html).toContain(`<p>文末は <a href="${URL}">${URL}</a> です。</p>`);
  });

  it('リンクにしても、note に渡す文字数の数え方は変わらない', () => {
    const html = toNoteHtml(`ご予約は ${URL} から`);
    // plainLength はタグを除くので、URL の文字数だけが数えられる
    expect(plainLength(html)).toBe(`ご予約は ${URL} から`.length);
  });
});

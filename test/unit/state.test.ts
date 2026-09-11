import { describe, it, expect } from 'vitest';
import {
  ARTICLE_STATES, canTransition, assertTransition, isTerminal, isResumable, needsDecision, MUST_ALLOW_CANCEL,
  InvalidTransitionError, type ArticleState,
} from '../../src/core/article/state';

describe('遷移表', () => {
  it('正常な一本道が通る', () => {
    const happy: ArticleState[] = [
      'received', 'generating', 'preview_ready', 'awaiting_approval', 'publishing', 'published',
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransition(happy[i], happy[i + 1]), `${happy[i]} -> ${happy[i + 1]}`).toBe(true);
    }
  });

  it('★承認待ちを飛ばして公開できない', () => {
    expect(canTransition('generating', 'publishing')).toBe(false);
    expect(canTransition('preview_ready', 'publishing')).toBe(false);
    expect(canTransition('received', 'published')).toBe(false);
  });

  it('★公開済みから直接もう一度公開はできない（二重投稿の防止）', () => {
    for (const to of ARTICLE_STATES) {
      if (to === 'editing') continue; // 修正のためだけ許可している
      expect(canTransition('published', to), `published -> ${to}`).toBe(false);
    }
  });

  it('公開済みは修正のために editing へ戻せる（note は上書き更新できる）', () => {
    expect(canTransition('published', 'editing')).toBe(true);
    // 修正後は editing → generating → ... → publishing の正規ルートを通る
    expect(canTransition('editing', 'generating')).toBe(true);
  });

  it('取り消し・期限切れも終端', () => {
    for (const from of ['cancelled', 'expired'] as const) {
      for (const to of ARTICLE_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('待機状態からは公開へ戻れる（条件回復時の自動再開）', () => {
    expect(canTransition('blocked', 'publishing')).toBe(true);
    expect(canTransition('awaiting_session', 'publishing')).toBe(true);
  });

  it('投稿失敗はセッション待ちへ退避できる', () => {
    expect(canTransition('publishing', 'awaiting_session')).toBe(true);
  });

  it('失敗からは再生成のみ許可する', () => {
    expect(canTransition('failed', 'generating')).toBe(true);
    expect(canTransition('failed', 'publishing')).toBe(false);
  });

  it('修正は承認待ちへ戻る', () => {
    expect(canTransition('awaiting_approval', 'editing')).toBe(true);
    expect(canTransition('editing', 'awaiting_approval')).toBe(true);
  });
});

describe('★修正フローの遷移（2026-08-28 のバグの再発防止）', () => {
  it('承認待ちから直接「生成中」へは飛べない', () => {
    // ここを直接つないでいたため、不正な状態が保存されて生成が失敗した
    expect(canTransition('awaiting_approval', 'generating')).toBe(false);
  });

  it('承認待ち → editing → 生成中 の順なら通る（正しい修正フロー）', () => {
    expect(canTransition('awaiting_approval', 'editing')).toBe(true);
    expect(canTransition('editing', 'generating')).toBe(true);
  });

  it('失敗からは指示を出し直して再生成できる', () => {
    expect(canTransition('failed', 'generating')).toBe(true);
  });

  it('生成中に失敗したら failed へ落とせる', () => {
    expect(canTransition('generating', 'failed')).toBe(true);
  });
});

describe('assertTransition', () => {
  it('不正な遷移は例外を投げる', () => {
    expect(() => assertTransition('received', 'published')).toThrow(InvalidTransitionError);
  });

  it('正常な遷移は例外を投げない', () => {
    expect(() => assertTransition('received', 'generating')).not.toThrow();
  });

  it('例外に遷移元と遷移先が入る', () => {
    try {
      assertTransition('published', 'generating');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).from).toBe('published');
      expect((e as InvalidTransitionError).to).toBe('generating');
    }
  });
});

describe('isTerminal / isResumable', () => {
  it('終端状態を正しく判定する', () => {
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('awaiting_approval')).toBe(false);
    // failed は再生成できるので終端ではない
    expect(isTerminal('failed')).toBe(false);
    // published も修正して再公開できるので終端ではない
    expect(isTerminal('published')).toBe(false);
  });

  it('Cron が再開すべき状態を判定する', () => {
    expect(isResumable('blocked')).toBe(true);
    expect(isResumable('awaiting_session')).toBe(true);
    expect(isResumable('awaiting_approval')).toBe(false);
  });
});

describe('★判断待ちのロック（作成中に別の記事を作らせない）', () => {
  it('本人の判断を待っている間はロックする', () => {
    for (const state of ['received', 'generating', 'preview_ready', 'awaiting_approval', 'editing', 'failed'] as const) {
      expect(needsDecision(state), state).toBe(true);
    }
  });

  it('判断が済んだらロックを外す（次の記事を作れる）', () => {
    // 公開した・下書きにした・やめた、のいずれかで解放される
    for (const state of ['published', 'drafted', 'cancelled', 'expired'] as const) {
      expect(needsDecision(state), state).toBe(false);
    }
  });

  it('投稿待ち・連携切れはロックしない（本人の判断は済んでいる）', () => {
    expect(needsDecision('blocked')).toBe(false);
    expect(needsDecision('awaiting_session')).toBe(false);
    expect(needsDecision('publishing')).toBe(false);
  });
});

describe('下書き保存の遷移', () => {
  it('承認待ちから下書き保存へ進める', () => {
    expect(canTransition('awaiting_approval', 'saving_draft')).toBe(true);
    expect(canTransition('saving_draft', 'drafted')).toBe(true);
  });

  it('修正中からも下書き保存できる', () => {
    expect(canTransition('editing', 'saving_draft')).toBe(true);
  });

  it('下書き保存済みからは、公開も書き直しもできる', () => {
    expect(canTransition('drafted', 'publishing')).toBe(true);
    expect(canTransition('drafted', 'editing')).toBe(true);
  });

  it('下書き保存に失敗したら連携切れに退避できる', () => {
    expect(canTransition('saving_draft', 'awaiting_session')).toBe(true);
    expect(canTransition('saving_draft', 'failed')).toBe(true);
  });

  it('★下書きから承認を飛ばして直接公開済みにはできない', () => {
    expect(canTransition('drafted', 'published')).toBe(false);
  });
});

describe('★「やめる」はどの作業中状態からでもできる（2026-08-28 の不具合の再発防止）', () => {
  // preview_ready と failed から cancelled へ行けず、ボタンを押しても
  // 例外で落ちて無反応になり、記事が片付かずロックが解けなくなった。
  it.each(MUST_ALLOW_CANCEL)('%s から「やめる」ができる', (state) => {
    expect(canTransition(state, 'cancelled')).toBe(true);
  });

  it('作業中の状態はすべて「やめる」の対象に入っている', () => {
    const working = ARTICLE_STATES.filter(
      (s) => !['published', 'cancelled', 'expired', 'publishing'].includes(s),
    );
    for (const s of working) {
      expect(MUST_ALLOW_CANCEL, `${s} が漏れている`).toContain(s);
    }
  });

  it('判断待ちの状態はすべて「やめる」でロックを外せる', () => {
    for (const state of ARTICLE_STATES) {
      if (!needsDecision(state)) continue;
      expect(canTransition(state, 'cancelled'), `${state} から抜けられない`).toBe(true);
    }
  });
});

describe('放置された記事の期限切れ', () => {
  it('作業中の状態からは期限切れにできる（Cron の掃除用）', () => {
    for (const state of ['received', 'generating', 'preview_ready', 'awaiting_approval', 'editing', 'failed'] as const) {
      expect(canTransition(state, 'expired'), state).toBe(true);
    }
  });
});

describe('★拡張（顧客のブラウザ）が実行する経路', () => {
  // 拡張は note への投稿を最後までやり切って結果だけを返す。
  // そのため awaiting_agent から直接 published / drafted へ進む。
  // ここに穴があると「投稿は成功しているのに状態が更新できない」になる。
  it('成功したら published / drafted へ進める', () => {
    expect(canTransition('awaiting_agent', 'published')).toBe(true);
    expect(canTransition('awaiting_agent', 'drafted')).toBe(true);
  });

  it('失敗の行き先もすべて用意されている', () => {
    for (const to of ['awaiting_session', 'blocked', 'failed', 'cancelled'] as const) {
      expect(canTransition('awaiting_agent', to), `→ ${to}`).toBe(true);
    }
  });

  it('待機中の状態から拡張へ渡せる', () => {
    for (const from of ['awaiting_approval', 'blocked', 'awaiting_session', 'drafted'] as const) {
      expect(canTransition(from, 'awaiting_agent'), `${from} →`).toBe(true);
    }
  });

  it('★拡張待ちの記事も「やめる」で必ず片付けられる', () => {
    expect(MUST_ALLOW_CANCEL).toContain('awaiting_agent');
    expect(canTransition('awaiting_agent', 'cancelled')).toBe(true);
  });

  it('Cron の再開対象に入っている', () => {
    expect(isResumable('awaiting_agent')).toBe(true);
  });
});

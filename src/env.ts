/** Worker のバインディングと環境変数。 */
export interface Env {
  // --- バインディング ---
  DB: D1Database;
  /** フラグ・カウンタ・画像の一時置き（R2 は未有効化のため KV を使う） */
  KV: KVNamespace;
  /** 記事生成ワークフロー（画像待ちの sleep を含む） */
  GENERATE: Workflow<import('./workflows/generate-article').GenerateParams>;

  // --- LINE（Phase 1 は単一テナントなので env から読む。Phase 2 で D1 へ移す）---
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_OWNER_USER_ID: string;

  // --- Claude（BYOK。Phase 2 ではテナントごとに D1 から復号して使う）---
  ANTHROPIC_API_KEY: string;
  /** ワークスペース紐づけキーを使う場合のみ設定（wrkspc_ で始まるID） */
  ANTHROPIC_WORKSPACE_ID?: string;

  // --- note セッション ---
  // ★通常は Chrome 拡張で連携され、暗号化して D1 に入る（core/session/）。
  //   ここは最初の環境の手動運用と、拡張が使えないときの逃げ道として残してある。
  NOTE_COOKIE?: string;
  NOTE_USER_AGENT?: string;
  NOTE_URLNAME?: string;

  // --- 暗号化マスター鍵 ---
  // ★これが無いと note セッションを保存できない（＝拡張からの連携を断る）。
  //   平文で預かるくらいなら連携させない、という判断。
  MASTER_KEY_V1?: string;
}

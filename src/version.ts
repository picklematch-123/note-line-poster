/**
 * この環境のコードの版。`/health` の `version` に出す（秘密ではない）。
 *
 * ★大元（開発用のフォルダ）では 'dev' のまま。
 *   配布物を組み立てるとき、scripts/build-template.mjs が `YYYYMMDD-<git の短い sha>` に書き換える。
 *   各環境の版をまとめて見るのは `npm run fleet`（運用側の道具）。
 * ★この行の形を変えるときは、build-template.mjs の stampVersion も直すこと（形が違うと組み立てが止まる）
 */
export const VERSION: string = '20261027-9ccb9f3-dirty-18611271';

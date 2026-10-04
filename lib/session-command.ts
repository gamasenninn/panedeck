/**
 * 会話を指定して起動するコマンドの組み立て（#33）。
 *
 * 復元したペインを**それぞれ自分の会話へ**戻すため、起動コマンドに会話の id を
 * 添える。`--continue` では足りない —— あれは「作業ディレクトリの最後の会話」を
 * 開くので、同じディレクトリに 3 枚あれば 3 枚が同じ会話を開く。
 *
 * **初回と再開で呼び方が違う。** 実測（claude 2.1.288）:
 *
 * | 呼び方 | 結果 |
 * |---|---|
 * | `--session-id <uuid>` 初回 | 新しい会話が始まる |
 * | `--session-id <uuid>` 2 回目 | `Session ID ... is already in use.` で落ちる |
 * | `--resume <uuid>` | 再開し、前の内容を覚えている |
 *
 * **1 つの呼び方に簡約してはいけない。** 簡約は 2 回目の起動でしか壊れないので、
 * 気づくのが最後になる。
 *
 * 呼び方そのものはプロファイルが持つ（#33 の「エージェントに依存しない」）。
 * ここは組み立てるだけで、どの形かは知らない。
 */

import type { SessionFlags } from "../types/panedeck";

export type { SessionFlags };

export type SessionMode = "start" | "resume";

/**
 * すでに会話を指している指定。
 *
 * **人が自分で書いたほうが強い。** `--continue` と書いた人はそれを望んでいるので、
 * 横から別の会話を指させない。
 *
 * 語の境界で見るのは、`tools/resume-report.js` のような**綴りが似ているだけ**の
 * ものを指定と誤認しないため。
 */
const ALREADY_CHOSEN = /(?:^|\s)(?:--continue|-c|--resume|-r|--session-id)(?=\s|$)/;

export function sessionCommand({
  command,
  flags,
  sessionId,
  mode,
}: {
  command: string | undefined;
  flags: SessionFlags | undefined;
  sessionId: string | undefined;
  mode: SessionMode;
}): string | undefined {
  if (!command) return command;
  if (!flags || !sessionId) return command;
  if (ALREADY_CHOSEN.test(command)) return command;

  return `${command} ${flags[mode].replace("{id}", sessionId)}`;
}

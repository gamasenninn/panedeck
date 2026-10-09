/**
 * 「全終了」の確認の文面（2026-10-09）。
 *
 * 以前は確認なしで全ペインを終了していた。作業中の claude も途中で止まり、
 * 復元用の控えも空で上書きされる。**何が止まるかを数で出す** —— 「本当に？」
 * だけの確認は反射で押される。
 *
 * 判断は出す、描画は残す。DOM は呼び出し側が読む。
 */

import type { SessionStatus } from "../types/panedeck";

/** 仕事の途中とみなす状態。確認待ちは人の答えを待って止まっているだけ */
const IN_PROGRESS: SessionStatus[] = ["running", "asking"];

export function closeAllPrompt(statuses: SessionStatus[]): { text: string } | null {
  if (statuses.length === 0) return null;

  const inProgress = statuses.filter((status) => IN_PROGRESS.includes(status)).length;
  const base = `${statuses.length} 個のセッションを終了します`;
  return { text: inProgress > 0 ? `${base}（作業の途中 ${inProgress}）` : base };
}

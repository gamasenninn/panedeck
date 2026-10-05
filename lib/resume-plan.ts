/**
 * 復元のときに、会話を再開するか新しく始めるかを決める（#33）。
 *
 * ## なぜ「先に調べる」のか
 *
 * 再開は失敗しうる —— 一度も会話せずに閉じたペインには記録が無い。失敗を
 * 終了コードから見分けようとすると、**正常なすぐ終了と区別が付かない**
 * （`node -e "..."` のペインは設計どおり即終了し、`exited` はデッキが
 * 普通に見せる状態）。
 *
 * だから、分かることは先に調べる。調べられないときだけ、試して落ちたら
 * 立て直す（退避は呼び出し側の仕事）。
 *
 * **記録の場所はプロファイルが持つ。** ここは「あるかないか」を聞くだけで、
 * どこにあるかは知らない。
 */

import type { WorkspaceEntry, SessionFlags } from "../types/panedeck";

/** 判断に使うプロファイルの部分だけ */
export interface ResumeProfile {
  sessionFlags?: SessionFlags;
  recordFile?: (cwd: string, sessionId: string) => string;
}

export interface ResumePlan {
  /** 渡す会話の id。新しく始めるなら undefined */
  sessionId: string | undefined;
  /** 再開するか */
  resume: boolean;
}

/** 新しい会話で始める */
const FRESH: ResumePlan = { sessionId: undefined, resume: false };

/**
 * 再開で起こしたペインが、これより早く異常終了したら「再開の失敗」とみなす。
 *
 * 長く走ってから落ちたのは、ただの終了。
 */
export const RESUME_FAILED_MS = 10_000;

/**
 * 新しい会話で立て直すべきか（#33 の退避）。
 *
 * **「すぐ終了した」だけでは正常な終了と区別できない。** `node -e "..."` の
 * ペインは設計どおり即終了し、`exited` はデッキが普通に見せる状態。だから
 * 呼ぶ側が「再開で起こしたペイン」に限って使うこと —— ここはその中で
 * 「異常終了」「すぐ」を見るだけ。
 */
export function shouldRetryFresh({
  exitCode,
  msSinceLaunch,
}: {
  exitCode: number;
  msSinceLaunch: number;
}): boolean {
  if (exitCode === 0) return false;
  return msSinceLaunch <= RESUME_FAILED_MS;
}

export function resumePlan({
  entry,
  profile,
  exists,
}: {
  entry: WorkspaceEntry;
  profile: ResumeProfile;
  exists: (file: string) => boolean;
}): ResumePlan {
  // 会話の概念が無いプロファイル（shell など）は従来どおり
  if (!profile.sessionFlags) return FRESH;

  // 常駐の受付など。記録があっても再開しない
  if (entry.noResume) return FRESH;

  const sessionId = entry.sessionId;
  if (!sessionId) return FRESH;

  // 場所を宣言しないプロファイルは調べられない。**試して、落ちたら立て直す**
  if (!profile.recordFile) return { sessionId, resume: true };

  try {
    return exists(profile.recordFile(entry.cwd, sessionId))
      ? { sessionId, resume: true }
      : FRESH;
  } catch {
    // 調べられないことで復元そのものを止めない
    return FRESH;
  }
}

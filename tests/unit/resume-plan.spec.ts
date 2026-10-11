import { test, expect } from "@playwright/test";
import {
  resumePlan,
  shouldRetryFresh,
  keepsSavedConversation,
  afterResumeFailure,
  RESUME_FAILED_MS,
} from "../../lib/resume-plan";

/**
 * 復元のときに、会話を再開するか新しく始めるかを決める（#33）。
 *
 * **先に調べる**のが主な道。記録が無ければ再開は失敗するので、調べて分かる
 * ことを終了コードから推測しない。異常終了したときの退避は呼び出し側の仕事で、
 * ここは「どう起こすか」だけを決める。
 */

const FLAGS = { start: "--session-id {id}", resume: "--resume {id}" };

/** 記録がある場所を宣言するプロファイル */
const withRecord = {
  sessionFlags: FLAGS,
  recordFile: (cwd: string, id: string) => `${cwd}/records/${id}.jsonl`,
};

/** 宣言しないプロファイル（shell など） */
const bare = { sessionFlags: undefined, recordFile: undefined };

test.describe("記録を調べて決める", () => {
  test("記録があれば再開する", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1" },
      profile: withRecord,
      exists: (file) => file === "/work/records/uuid-1.jsonl",
    });

    expect(plan).toEqual({ sessionId: "uuid-1", resume: true });
  });

  /** 一度も会話せずに閉じたペインには記録が無い */
  test("記録が無ければ新しい会話で始める", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1" },
      profile: withRecord,
      exists: () => false,
    });

    expect(plan).toEqual({ sessionId: undefined, resume: false });
  });

  test("保存された id が無ければ新しい会話で始める", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [] },
      profile: withRecord,
      exists: () => true,
    });

    expect(plan).toEqual({ sessionId: undefined, resume: false });
  });
});

test.describe("調べない場面", () => {
  /**
   * 場所を宣言しないプロファイルは調べられない。**退避だけに頼る** ——
   * 再開を試して、落ちたら新しい会話で立て直す
   */
  test("記録の場所を宣言しないプロファイルは、調べずに再開を試す", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1" },
      profile: { sessionFlags: FLAGS, recordFile: undefined },
      exists: () => {
        throw new Error("調べてはいけない");
      },
    });

    expect(plan).toEqual({ sessionId: "uuid-1", resume: true });
  });

  test("会話の概念が無いプロファイルは従来どおり", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1" },
      profile: bare,
      exists: () => true,
    });

    expect(plan).toEqual({ sessionId: undefined, resume: false });
  });

  /** 受付のような常駐。新しい会話で足りるうえ、長い会話を抱えて起きるより軽い */
  test("再開しない印があれば、記録があっても新しく始める", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1", noResume: true },
      profile: withRecord,
      exists: () => true,
    });

    expect(plan).toEqual({ sessionId: undefined, resume: false });
  });
});

test.describe("調べられないとき", () => {
  /** 記録を見にいって例外になっても、復元そのものを止めない */
  test("調べられなければ新しい会話で始める", () => {
    const plan = resumePlan({
      entry: { cwd: "/work", args: [], sessionId: "uuid-1" },
      profile: withRecord,
      exists: () => {
        throw new Error("読めません");
      },
    });

    expect(plan).toEqual({ sessionId: undefined, resume: false });
  });
});

/**
 * 再開に失敗したとみなすかの判断（#33 の退避）。
 *
 * **「すぐ終了した」を正常な終了と区別できない**のが難しいところ。
 * `node -e "..."` のペインは設計どおり即終了し、`exited` はデッキが普通に
 * 見せる状態。だから**再開で起こしたときだけ**、**異常終了で**、**すぐに**
 * 落ちたものを失敗とみなす。
 */
test.describe("再開の失敗とみなすか", () => {
  const W = RESUME_FAILED_MS;

  test("再開で起こして、すぐ異常終了したら失敗とみなす", () => {
    expect(shouldRetryFresh({ exitCode: 1, msSinceLaunch: 500 })).toBe(true);
  });

  test("正常終了は失敗とみなさない", () => {
    expect(shouldRetryFresh({ exitCode: 0, msSinceLaunch: 500 })).toBe(false);
  });

  /** 長く走ってから落ちたのは、ただの終了 */
  test("しばらく走ってから落ちたのは失敗とみなさない", () => {
    expect(shouldRetryFresh({ exitCode: 1, msSinceLaunch: W + 1 })).toBe(false);
  });

  test("境界では失敗とみなす", () => {
    expect(shouldRetryFresh({ exitCode: 1, msSinceLaunch: W })).toBe(true);
  });
});

/**
 * 再開が落ちて新しい会話で立て直しても、**記録がある会話の id は構成に残す**。
 *
 * 一時的な失敗（自動更新・メモリ不足など）で、記録の残る会話への道を断たない。
 * 立て直したペインは新しい会話で動くが、保存するのは元の id。
 */
test.describe("立て直しても元の会話を残す", () => {
  const entry = { cwd: "/work", args: [], sessionId: "uuid-1" };

  test("記録が残っていれば、元の id を残す", () => {
    expect(
      keepsSavedConversation({ entry, profile: withRecord, exists: () => true }),
    ).toBe(true);
  });

  test("記録が無ければ残さない（死んだ id を永久に試さないため）", () => {
    expect(
      keepsSavedConversation({ entry, profile: withRecord, exists: () => false }),
    ).toBe(false);
  });

  test("記録の場所を宣言しないプロファイルは残さない", () => {
    expect(
      keepsSavedConversation({ entry, profile: bare, exists: () => true }),
    ).toBe(false);
  });

  test("id が無ければ残さない", () => {
    expect(
      keepsSavedConversation({
        entry: { cwd: "/work", args: [] },
        profile: withRecord,
        exists: () => true,
      }),
    ).toBe(false);
  });

  test("調べて例外になっても残さない", () => {
    expect(
      keepsSavedConversation({
        entry,
        profile: withRecord,
        exists: () => {
          throw new Error("x");
        },
      }),
    ).toBe(false);
  });
});

/**
 * 再開が落ちたあと、どうするか。
 *
 * 記録が残る会話は、**立て直す前にもう一度だけ再開を試す**（一時的な失敗なら通る）。
 * それでも落ちたら新しい会話で立て直す。記録が無ければ試さず、すぐ立て直す。
 */
test.describe("再開が落ちたあとの次の手", () => {
  test("記録が残り、まだ試していなければ、もう一度再開する", () => {
    expect(afterResumeFailure({ recordKept: true, retried: false })).toBe("retry-resume");
  });

  test("もう一度試して落ちたなら、新しい会話で立て直す", () => {
    expect(afterResumeFailure({ recordKept: true, retried: true })).toBe("fresh");
  });

  test("記録が無ければ、試さず立て直す", () => {
    expect(afterResumeFailure({ recordKept: false, retried: false })).toBe("fresh");
  });
});

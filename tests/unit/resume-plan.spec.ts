import { test, expect } from "@playwright/test";
import { resumePlan } from "../../lib/resume-plan";

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

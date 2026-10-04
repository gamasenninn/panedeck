import { test, expect } from "@playwright/test";
import { sessionCommand } from "../../lib/session-command";

/**
 * 会話を指定して起動するコマンドの組み立て（#33）。
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
 * ここは判断だけを出す純粋関数。実際に起こすのは呼び出し側。
 */

const FLAGS = { start: "--session-id {id}", resume: "--resume {id}" };
const ID = "3f8c1a52-6b47-4d19-9e2a-7c5b0d84f6a1";

test.describe("会話を指定して起動する", () => {
  test("初回は始める形で付ける", () => {
    expect(
      sessionCommand({ command: "claude", flags: FLAGS, sessionId: ID, mode: "start" })
    ).toBe(`claude --session-id ${ID}`);
  });

  test("再開は再開の形で付ける", () => {
    expect(
      sessionCommand({ command: "claude", flags: FLAGS, sessionId: ID, mode: "resume" })
    ).toBe(`claude --resume ${ID}`);
  });

  test("引数つきのコマンドでも後ろに付く", () => {
    expect(
      sessionCommand({
        command: "claude --model opus",
        flags: FLAGS,
        sessionId: ID,
        mode: "start",
      })
    ).toBe(`claude --model opus --session-id ${ID}`);
  });
});

test.describe("触らない場面", () => {
  test("起動コマンドが無ければ何もしない（素のシェル）", () => {
    expect(
      sessionCommand({ command: undefined, flags: FLAGS, sessionId: ID, mode: "start" })
    ).toBeUndefined();
  });

  /** shell のように会話の概念が無いプロファイル。従来どおり起動する */
  test("プロファイルが宣言していなければ素のまま", () => {
    expect(
      sessionCommand({ command: "npm run dev", flags: undefined, sessionId: ID, mode: "start" })
    ).toBe("npm run dev");
  });

  test("会話 id が無ければ素のまま", () => {
    expect(
      sessionCommand({ command: "claude", flags: FLAGS, sessionId: undefined, mode: "start" })
    ).toBe("claude");
  });

  /**
   * **人が自分で書いた指定のほうが強い。** `--continue` と書いた人は
   * それを望んでいるので、横から別の会話を指させない。
   */
  for (const written of [
    "claude --continue",
    "claude -c",
    "claude --resume abc",
    "claude -r abc",
    "claude --session-id abc",
  ]) {
    test(`すでに会話を指している指定には足さない: ${written}`, () => {
      expect(
        sessionCommand({ command: written, flags: FLAGS, sessionId: ID, mode: "start" })
      ).toBe(written);
    });
  }

  /** 語の一部に見えるだけのものを、指定と誤認しない */
  test("似た綴りを指定と誤認しない", () => {
    expect(
      sessionCommand({
        command: "node tools/resume-report.js",
        flags: FLAGS,
        sessionId: ID,
        mode: "start",
      })
    ).toBe(`node tools/resume-report.js --session-id ${ID}`);
  });
});

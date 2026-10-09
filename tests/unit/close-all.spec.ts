import { test, expect } from "@playwright/test";
import { closeAllPrompt } from "../../renderer/close-all";

/**
 * 「全終了」の確認の文面（2026-10-09）。
 *
 * 以前は**確認なしで**全ペインを終了していた。作業中の claude も途中で止まり、
 * 復元用の控えも空で上書きされる。押し間違い 1 回で、本体と受付の会話の
 * つながりが両方切れる。
 *
 * **何が止まるかを数で出す。** 「本当に？」だけの確認は反射で押される。
 */
test.describe("closeAllPrompt", () => {
  test("ペインが無ければ確認しない", () => {
    expect(closeAllPrompt([])).toBeNull();
  });

  test("作業の途中が無ければ、数だけ出す", () => {
    expect(closeAllPrompt(["ready", "idle"])?.text).toBe("2 個のセッションを終了します");
  });

  /** 確認待ちも途中。人の答えを待って止まっているだけで、仕事は終わっていない */
  test("作業中と確認待ちは「作業の途中」として数える", () => {
    expect(closeAllPrompt(["running", "asking", "ready"])?.text).toBe(
      "3 個のセッションを終了します（作業の途中 2）"
    );
  });

  test("終了済みや待機は途中に数えない", () => {
    expect(closeAllPrompt(["exited", "idle", "waiting"])?.text).toBe(
      "3 個のセッションを終了します"
    );
  });
});

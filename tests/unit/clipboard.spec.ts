import { test, expect } from "@playwright/test";
import { shouldCopySelection } from "../../renderer/clipboard";

/** xterm の attachCustomKeyEventHandler へ渡ってくる形の最小構成 */
function keydown(
  key: string,
  { ctrl = false, shift = false, meta = false, type = "keydown" } = {}
) {
  return { type, key, ctrlKey: ctrl, shiftKey: shift, metaKey: meta };
}

test.describe("shouldCopySelection", () => {
  test("Ctrl+Shift+C はコピー", () => {
    expect(shouldCopySelection(keydown("C", { ctrl: true, shift: true }), true)).toBe(
      true
    );
  });

  test("Ctrl+Insert もコピー（端末の慣習）", () => {
    expect(shouldCopySelection(keydown("Insert", { ctrl: true }), true)).toBe(true);
  });

  test("選択があるときの Ctrl+C はコピー", () => {
    // 選択したうえで Ctrl+C を押すなら、中断ではなくコピーを意図している
    expect(shouldCopySelection(keydown("c", { ctrl: true }), true)).toBe(true);
  });

  test("選択が無ければ Ctrl+C は中断のまま", () => {
    // ここを奪うと、実行中のコマンドを止める手段が無くなる
    expect(shouldCopySelection(keydown("c", { ctrl: true }), false)).toBe(false);
  });

  test("選択が無ければ Ctrl+Shift+C も何もしない", () => {
    expect(shouldCopySelection(keydown("C", { ctrl: true, shift: true }), false)).toBe(
      false
    );
  });

  test("macOS の Cmd+C はコピー", () => {
    expect(shouldCopySelection(keydown("c", { meta: true }), true)).toBe(true);
  });

  test("修飾なしの c は文字入力のまま", () => {
    expect(shouldCopySelection(keydown("c"), true)).toBe(false);
  });

  test("Ctrl+V や他のキーは対象外", () => {
    expect(shouldCopySelection(keydown("v", { ctrl: true }), true)).toBe(false);
    expect(shouldCopySelection(keydown("a", { ctrl: true }), true)).toBe(false);
  });

  test("keyup / keypress では反応しない（二重に走らせない）", () => {
    // attachCustomKeyEventHandler は keydown 以外でも呼ばれる
    for (const type of ["keyup", "keypress"]) {
      expect(
        shouldCopySelection(keydown("c", { ctrl: true, type }), true)
      ).toBe(false);
    }
  });

  test("大文字小文字を問わない", () => {
    expect(shouldCopySelection(keydown("c", { ctrl: true, shift: true }), true)).toBe(
      true
    );
    expect(shouldCopySelection(keydown("C", { ctrl: true }), true)).toBe(true);
  });
});

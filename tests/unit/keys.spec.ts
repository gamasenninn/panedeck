import { test, expect } from "@playwright/test";
import { NEWLINE_SEQUENCE, newlineSequenceFor } from "../../renderer/keys";

function keydown(
  key: string,
  { ctrl = false, shift = false, alt = false, meta = false, type = "keydown" } = {}
) {
  return { type, key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
}

test.describe("newlineSequenceFor", () => {
  test("Ctrl+Enter は改行を送る", () => {
    expect(newlineSequenceFor(keydown("Enter", { ctrl: true }))).toBe(
      NEWLINE_SEQUENCE
    );
  });

  test("Shift+Enter も同じ", () => {
    expect(newlineSequenceFor(keydown("Enter", { shift: true }))).toBe(
      NEWLINE_SEQUENCE
    );
  });

  test("両方押していても改行", () => {
    expect(newlineSequenceFor(keydown("Enter", { ctrl: true, shift: true }))).toBe(
      NEWLINE_SEQUENCE
    );
  });

  test("修飾なしの Enter は触らない（確定のまま）", () => {
    // ここを奪うと入力を確定する手段が無くなる
    expect(newlineSequenceFor(keydown("Enter"))).toBeNull();
  });

  test("Alt+Enter は触らない（xterm が既に ESC CR を送る）", () => {
    expect(newlineSequenceFor(keydown("Enter", { alt: true }))).toBeNull();
    expect(newlineSequenceFor(keydown("Enter", { alt: true, ctrl: true }))).toBeNull();
  });

  test("Enter 以外は対象外", () => {
    expect(newlineSequenceFor(keydown("c", { ctrl: true }))).toBeNull();
    expect(newlineSequenceFor(keydown("j", { ctrl: true }))).toBeNull();
  });

  test("keyup / keypress では反応しない", () => {
    for (const type of ["keyup", "keypress"]) {
      expect(newlineSequenceFor(keydown("Enter", { ctrl: true, type }))).toBeNull();
    }
  });

  test("送るのは ESC CR", () => {
    // Alt+Enter として広く使われている形。Claude Code もこれを改行として扱う
    expect(NEWLINE_SEQUENCE).toBe("\x1b\r");
  });
});

import { test, expect } from "@playwright/test";
import { secondLaunchNotice } from "../../lib/second-launch";

/**
 * 2 つ目の PaneDeck を起動しようとしたとき、1 つ目に出す知らせ（2026-10-11）。
 *
 * 2 つ目は同じ設定を読むので、前回の構成を復元して同じ会話を二重に再開し、
 * 裏のコマンドもトリガーも二重に動く。だから 2 つ目は起動しない。黙って
 * 終わると「起動しなかった」ことに気づけないので、1 つ目が知らせる
 */
test.describe("2 つ目を起動しようとしたときの知らせ", () => {
  test("フォルダの指定が無ければ、起動しなかったことだけを言う", () => {
    expect(secondLaunchNotice({}, {})).toBe(
      "PaneDeck はすでに動いています。2 つ目は起動しませんでした"
    );
  });

  test("いま開いているのと同じフォルダなら、それ以上は言わない", () => {
    expect(secondLaunchNotice({ folder: "C:\\system" }, { folder: "C:\\system" })).toBe(
      "PaneDeck はすでに動いています。2 つ目は起動しませんでした"
    );
  });

  /** Windows は大文字小文字を区別しない（実際に `c:\system` と打たれた） */
  test("同じ場所かの比べ方は渡せる（Windows では大文字小文字を区別しない）", () => {
    const sameOnWindows = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(
      secondLaunchNotice({ folder: "C:\\system" }, { folder: "c:\\system" }, sameOnWindows)
    ).toBe("PaneDeck はすでに動いています。2 つ目は起動しませんでした");
  });

  /** 別のフォルダで動かしたつもりで、サービスが今の場所のまま、を防ぐ */
  test("別のフォルダを指定していたら、開かれていないことと、開き直し方を言う", () => {
    expect(secondLaunchNotice({ folder: "C:\\work" }, { folder: "C:\\system" })).toBe(
      "PaneDeck はすでに動いています。2 つ目は起動しませんでした。" +
        "C:\\system は開いていません（いまは C:\\work）。開くには、いったん閉じてから開き直してください"
    );
  });

  test("いまフォルダを開いていなければ、そう書く", () => {
    expect(secondLaunchNotice({}, { folder: "C:\\system" })).toContain(
      "（いまはフォルダを開いていません）"
    );
  });

  test("無いフォルダを指定していたら、それも言う", () => {
    expect(secondLaunchNotice({}, { missing: "C:\\nowhere" })).toBe(
      "PaneDeck はすでに動いています。2 つ目は起動しませんでした。" +
        "指定のフォルダも開けません（無いか、フォルダではない）: C:\\nowhere"
    );
  });
});

import { test, expect } from "@playwright/test";
import {
  targetIds,
  broadcastOptions,
  noTargetMessage,
  targetLabel,
} from "../../renderer/broadcast";
import type { BroadcastPane } from "../../renderer/broadcast";

/**
 * 一斉入力の送信先の決まり方。
 *
 * 「誰に届くか」はこの製品の主機能なので、画面の配線から切り離して
 * ここで確かめる。DOM も panes も触らない純粋関数だけを対象にする。
 */

function pane(
  id: string,
  status: BroadcastPane["status"],
  selected = false
): BroadcastPane {
  return { id, status, selected };
}

const FOUR: BroadcastPane[] = [
  pane("s1", "waiting"),
  pane("s2", "running"),
  pane("s3", "waiting"),
  pane("s4", "idle"),
];

test.describe("targetIds", () => {
  test("選択が無ければ null（＝全ペイン）を返す", () => {
    // 絞り込みはメイン側が行うので、レンダラは「指定なし」を伝えるだけ
    expect(targetIds(FOUR)).toBeNull();
  });

  test("選択があればその id だけを返す", () => {
    const panes = [
      pane("s1", "waiting", true),
      pane("s2", "running"),
      pane("s3", "idle", true),
    ];
    expect(targetIds(panes)).toEqual(["s1", "s3"]);
  });

  test("ペインが無ければ null", () => {
    expect(targetIds([])).toBeNull();
  });

  test("状態では絞らない（終了済みでも選択されていれば入る）", () => {
    // 状態による絞り込みは onlyStatus の役目。ここで二重に判定しない
    const panes = [pane("s1", "exited", true)];
    expect(targetIds(panes)).toEqual(["s1"]);
  });
});

test.describe("broadcastOptions", () => {
  test("入力待ちのみが off なら指定なし", () => {
    expect(broadcastOptions(false)).toBeUndefined();
  });

  test("on なら入力待ちで絞る", () => {
    expect(broadcastOptions(true)).toEqual({ onlyStatus: "waiting" });
  });
});

test.describe("noTargetMessage", () => {
  test("入力待ちのみが on なら、その理由を言う", () => {
    expect(noTargetMessage(true)).toBe("入力待ちのペインがありません");
  });

  test("off なら送信先が無いとだけ言う", () => {
    expect(noTargetMessage(false)).toBe("送信先のペインがありません");
  });
});

/**
 * 送信先の表示。送る前にユーザーが読む唯一の手がかりなので、
 * 選択の有無 × 入力待ちのみの有無で 4 通りすべてを確かめる。
 */
test.describe("targetLabel", () => {
  test("選択なし・絞りなし → 全ペイン", () => {
    expect(targetLabel(FOUR, false)).toBe("送信先: 全 4 ペイン");
  });

  test("選択あり・絞りなし → 選択した数", () => {
    const panes = [
      pane("s1", "waiting", true),
      pane("s2", "running", true),
      pane("s3", "idle"),
    ];
    expect(targetLabel(panes, false)).toBe("送信先: 選択 2 ペイン");
  });

  test("選択なし・絞りあり → 入力待ちの数", () => {
    expect(targetLabel(FOUR, true)).toBe("送信先: 入力待ち 2 ペイン");
  });

  test("選択あり・絞りあり → 選択のうち入力待ちの数", () => {
    const panes = [
      pane("s1", "waiting", true),
      pane("s2", "running", true),
      // 選択されていない入力待ちは数に入らない
      pane("s3", "waiting"),
    ];
    expect(targetLabel(panes, true)).toBe("送信先: 選択のうち入力待ち 1 ペイン");
  });

  test("ペインが無ければ 0 ペイン", () => {
    expect(targetLabel([], false)).toBe("送信先: 全 0 ペイン");
    expect(targetLabel([], true)).toBe("送信先: 入力待ち 0 ペイン");
  });
});

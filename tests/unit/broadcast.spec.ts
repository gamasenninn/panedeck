import { test, expect } from "@playwright/test";
import {
  targetIds,
  optionsForKey,
  textOptions,
  isInterruptKey,
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

/**
 * 特殊キーは目的で二手に分かれる（#25）。
 *
 * Enter / ↑ / ↓ は「止まっているペインを進める」ためのもので、入力待ちに
 * 絞るのが目的そのもの。Esc / Ctrl+C は「動いているペインを止める」ための
 * もので、入力待ちに絞ると**止めたい相手にだけ届かない**。
 */
test.describe("isInterruptKey", () => {
  test("中断のキー", () => {
    expect(isInterruptKey("esc")).toBe(true);
    expect(isInterruptKey("ctrl-c")).toBe(true);
  });

  test("進めるキー", () => {
    expect(isInterruptKey("enter")).toBe(false);
    expect(isInterruptKey("up")).toBe(false);
    expect(isInterruptKey("down")).toBe(false);
  });

  test("知らないキーは中断扱いしない（絞り込みを勝手に外さない）", () => {
    expect(isInterruptKey("nonsense")).toBe(false);
  });
});

test.describe("optionsForKey", () => {
  test("進めるキーは止まっているペインすべてへ", () => {
    const stopped = { onlyStatus: ["ready", "asking", "waiting"] };
    expect(optionsForKey("enter", true)).toEqual(stopped);
    expect(optionsForKey("up", true)).toEqual(stopped);
    expect(optionsForKey("down", true)).toEqual(stopped);
  });

  test("中断のキーは絞り込みを無視する", () => {
    expect(optionsForKey("esc", true)).toBeUndefined();
    expect(optionsForKey("ctrl-c", true)).toBeUndefined();
  });

  test("絞り込みが off ならどちらも指定なし", () => {
    expect(optionsForKey("enter", false)).toBeUndefined();
    expect(optionsForKey("ctrl-c", false)).toBeUndefined();
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

  test("選択なし・絞りあり → 指示待ちの数と、外れた内訳", () => {
    // FOUR は waiting 2・running 1・idle 1。指示待ちは 0 で、
    // 判別できない 2 枚が外れたことを出す
    expect(targetLabel(FOUR, true)).toBe(
      "送信先: 指示待ち 0 ペイン（判別不可 2 は対象外）"
    );
  });

  test("選択あり・絞りあり → 選択のうち指示待ちの数", () => {
    const panes = [
      pane("s1", "ready", true),
      pane("s2", "running", true),
      // 選択されていない指示待ちは数に入らない
      pane("s3", "ready"),
    ];
    expect(targetLabel(panes, true)).toBe("送信先: 選択のうち指示待ち 1 ペイン");
  });

  test("ペインが無ければ 0 ペイン", () => {
    expect(targetLabel([], false)).toBe("送信先: 全 0 ペイン");
    expect(targetLabel([], true)).toBe("送信先: 指示待ち 0 ペイン");
  });
});

/**
 * 送るものによって対象が変わる（#27）。
 *
 * テキストは**指示待ちだけ**。確認待ちのペインへ送ると、打った文字が
 * 指示ではなく「回答」になる。Enter / ↑ / ↓ は逆で、確認待ちを進めるのが
 * 主用途なので両方へ届かせる。判別できない `waiting` は、キーには届かせるが
 * テキストからは外す（見分けられない以上、送ってよいとは言えない）。
 */
test.describe("送るものによる対象の違い", () => {
  test("テキストは指示待ちだけ", () => {
    expect(textOptions(true)).toEqual({ onlyStatus: ["ready"] });
  });

  test("進めるキーは指示待ちと確認待ち、判別不可にも届く", () => {
    expect(optionsForKey("enter", true)).toEqual({
      onlyStatus: ["ready", "asking", "waiting"],
    });
  });

  test("中断のキーは絞り込みを無視する（#25）", () => {
    expect(optionsForKey("ctrl-c", true)).toBeUndefined();
  });

  test("絞り込みが off なら、どれも指定なし", () => {
    expect(textOptions(false)).toBeUndefined();
    expect(optionsForKey("enter", false)).toBeUndefined();
  });
});

/**
 * 黙って減らさない（#27）。
 *
 * テキストが指示待ちだけに絞られると、確認待ちや判別不可のペインは外れる。
 * 送る前に読む一行に出しておかないと、独自プロファイルの利用者が
 * 「なぜ届かない」で迷う。
 */
test.describe("targetLabel - 対象外の内訳", () => {
  const deck: BroadcastPane[] = [
    pane("s1", "ready"),
    pane("s2", "ready"),
    pane("s3", "asking"),
    pane("s4", "waiting"),
    pane("s5", "idle"),
  ];

  test("絞り込みが off なら全ペイン", () => {
    expect(targetLabel(deck, false)).toBe("送信先: 全 5 ペイン");
  });

  test("絞り込むと、対象の数と外れた内訳を出す", () => {
    expect(targetLabel(deck, true)).toBe(
      "送信先: 指示待ち 2 ペイン（確認待ち 1・判別不可 1 は対象外）"
    );
  });

  test("外れるものが無ければ内訳は出さない", () => {
    expect(targetLabel([pane("s1", "ready"), pane("s2", "idle")], true)).toBe(
      "送信先: 指示待ち 1 ペイン"
    );
  });
});

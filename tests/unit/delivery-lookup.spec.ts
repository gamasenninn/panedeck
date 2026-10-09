import { test, expect } from "@playwright/test";
import { lookupDelivery } from "../../lib/delivery-lookup";

/**
 * id を渡すと、その便がどうなったかを答える（#37 の一歩、2026-10-10）。
 *
 * 送り手は「届いたか」を記録で探していた。本体と受付の 3 往復で、**どのファイルを
 * 見るか（配った日付）と時刻の換算（UTC から 9 時間足す）で受付が 2 か所間違えた**。
 * 手順を決まりに書いても、毎回人手でやるならまた間違える。
 *
 * ここは記録の行から判断するだけ。**ファイルは全部読む**ので、どの日付を見るかは
 * そもそも考えなくてよい（片付けで 30 日分、1 日数 KB）。
 */
const row = (kind: string, at: string, ids: string[], extra: Record<string, unknown> = {}) => ({
  kind,
  at,
  title: "受付",
  watch: "C:/x/mailbox/受付.jsonl",
  ids,
  ...extra,
});

test.describe("lookupDelivery", () => {
  test("届いていれば delivered。打った時刻・届いた時刻・待ち・押し直しを返す", () => {
    const result = lookupDelivery(
      [
        row("typed", "2026-10-09T18:02:53.743Z", ["mb-9"]),
        row("delivery", "2026-10-09T18:02:54.666Z", ["mb-9"], { waitedMs: 923, submits: 1 }),
      ],
      "mb-9"
    );
    expect(result.status).toBe("delivered");
    expect(result.typedAt).toBe("2026-10-09T18:02:53.743Z");
    expect(result.deliveredAt).toBe("2026-10-09T18:02:54.666Z");
    expect(result.waitedMs).toBe(923);
    expect(result.submits).toBe(1);
    expect(result.title).toBe("受付");
  });

  test("打っただけなら typed（まだ確かめている）", () => {
    const result = lookupDelivery([row("typed", "2026-10-09T18:00:00Z", ["mb-1"])], "mb-1");
    expect(result.status).toBe("typed");
  });

  test("実行されずに諦めたなら not-executed", () => {
    const result = lookupDelivery(
      [
        row("typed", "2026-10-09T18:00:00Z", ["mb-1"]),
        row("not-executed", "2026-10-09T18:00:13Z", ["mb-1"], { submits: 3 }),
      ],
      "mb-1"
    );
    expect(result.status).toBe("not-executed");
  });

  /** 諦めた後に人が入力欄を片付けると、打ち直して届く。最後の結果が答え */
  test("諦めた後に届き直したら delivered", () => {
    const result = lookupDelivery(
      [
        row("typed", "2026-10-09T18:00:00Z", ["mb-1"]),
        row("not-executed", "2026-10-09T18:00:13Z", ["mb-1"]),
        row("typed", "2026-10-09T18:05:00Z", ["mb-1"]),
        row("delivery", "2026-10-09T18:05:01Z", ["mb-1"], { waitedMs: 300000, submits: 1 }),
      ],
      "mb-1"
    );
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-10-09T18:05:01Z");
  });

  test("まとめて届いた便の中に居ても見つける", () => {
    const result = lookupDelivery(
      [row("delivery", "2026-10-09T18:00:01Z", ["mb-1", "mb-2", "mb-3"], { waitedMs: 5000, submits: 1 })],
      "mb-2"
    );
    expect(result.status).toBe("delivered");
    expect(result.batch).toBe(3);
  });

  test("どこにも無ければ not-found", () => {
    const result = lookupDelivery([row("delivery", "2026-10-09T18:00:01Z", ["mb-1"])], "mb-x");
    expect(result.status).toBe("not-found");
  });

  /** ids が入る前（10/9 以前）の行には ids が無い。読めずに落ちない */
  test("ids を持たない古い行があっても落ちない", () => {
    const result = lookupDelivery(
      [{ kind: "delivery", at: "2026-10-08T03:40:00Z", title: "受付", count: 1 }],
      "mb-1"
    );
    expect(result.status).toBe("not-found");
  });

  /**
   * ★ **id を記録しない頃の便は探せない**（実機で踏んだ: 10/8 に確かに届いた便が
   * 「見つかりません」になり、作業中・上限…と見当違いの理由を並べた）。
   * id の無い配達の行が記録にあれば、それを最初の手がかりにする
   */
  test("id の無い配達の行があれば、id を記録しない頃の便かもしれないと知らせる", () => {
    const result = lookupDelivery(
      [{ kind: "delivery", at: "2026-10-08T14:22:56Z", title: "受付", count: 1 }],
      "mb-honntai-5",
      Date.parse("2026-10-10T00:00:00Z")
    );
    expect(result.status).toBe("not-found");
    expect(result.untracked).toBe(true);
  });

  test("全部の配達に id があれば、その知らせは出さない", () => {
    const result = lookupDelivery(
      [row("delivery", "2026-10-09T18:00:01Z", ["mb-1"])],
      "mb-x",
      Date.parse("2026-10-10T00:00:00Z")
    );
    expect(result.untracked).toBe(false);
  });

  /** 古い止まりは今の配達と関係が無い（実機では 10/6 の閉じたときの偽の行が出た） */
  test("止まりの知らせは、この 24 時間のものだけ", () => {
    const result = lookupDelivery(
      [
        { kind: "trigger-error", at: "2026-10-06T04:45:00Z", title: "受付", reason: "古い" },
        { kind: "trigger-capped", at: "2026-10-09T18:00:00Z", title: "受付" },
      ],
      "mb-x",
      Date.parse("2026-10-10T00:00:00Z")
    );
    expect(result.hints.map((h) => h.at)).toEqual(["2026-10-09T18:00:00Z"]);
  });

  /** 見つからないときの手がかり。止まっている理由が記録にあれば、それを出す */
  test("見つからないとき、止まりの知らせ（上限・規則違反・届け先）を手がかりに返す", () => {
    const result = lookupDelivery(
      [
        { kind: "trigger-capped", at: "2026-10-09T18:00:00Z", title: "受付", watch: "w" },
        { kind: "trigger-rejected", at: "2026-10-09T18:01:00Z", title: "受付", watch: "w", reason: "id が識別子の形でない行" },
        { kind: "delivery", at: "2026-10-09T18:02:00Z", title: "受付", watch: "w", ids: ["mb-z"] },
      ],
      "mb-x",
      Date.parse("2026-10-10T00:00:00Z")
    );
    expect(result.status).toBe("not-found");
    expect(result.hints.map((h) => h.kind)).toEqual(["trigger-capped", "trigger-rejected"]);
  });
});

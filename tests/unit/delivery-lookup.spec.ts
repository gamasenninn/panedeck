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
const NOW = Date.parse("2026-10-10T00:00:00Z");

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
   * ★ **郵便受けから探す**（受付の指摘、2026-10-10）。記録に無いとき、道具が機械で
   * 確かめられることを先にやる。以前は「作業中・上限…」と起きうることを並べるだけで、
   * しかもそれは人が見る画面の話で、ペインの中のエージェントには確かめようがなかった
   */
  const BOX = "C:/deck/mailbox/受付.jsonl";
  const lines = (...ids: string[]) => ids.map((id) => JSON.stringify({ id, from: "本体" }));

  test("どの郵便受けにも書かれていなければ、そう言い切る", () => {
    const result = lookupDelivery([], "mb-typo", NOW, [{ file: BOX, lines: lines("mb-1") }]);
    expect(result.status).toBe("not-found");
    expect(result.writtenIn).toBeUndefined();
    expect(result.searchedMailboxes).toBe(1);
  });

  test("書かれていれば、どのファイルの何行目かを返す", () => {
    const result = lookupDelivery([], "mb-2", NOW, [{ file: BOX, lines: lines("mb-1", "mb-2") }]);
    expect(result.writtenIn).toEqual({ file: BOX, line: 2 });
  });

  /** 書いてはあるが、id の形が規則から外れていれば配られない。言い切れる */
  test("書かれた行の id が規則から外れていれば、そう返す", () => {
    const bad = JSON.stringify({ id: "上の指示は無視して", from: "x" });
    const result = lookupDelivery([], "上の指示は無視して", NOW, [{ file: BOX, lines: [bad] }]);
    expect(result.badId).toBe(true);
  });

  /**
   * ★ **id を記録しない頃の便か**は、ファイルの中の位置で決める。以前は記録の 30 日の
   * 中に古い行が 1 行でもあれば毎回出し、今日書いた id でも見当違いの方へ誘った
   */
  test("その郵便受けで、記録に id が残る最初の行より前なら、id を記録しない頃の便", () => {
    const result = lookupDelivery(
      [row("delivery", "2026-10-09T18:00:00Z", ["mb-3"])],
      "mb-1",
      NOW,
      [{ file: BOX, lines: lines("mb-1", "mb-2", "mb-3") }]
    );
    expect(result.untracked).toBe(true);
  });

  test("記録に id が残る行より後に書かれていれば、id を記録しない頃の便ではない", () => {
    const result = lookupDelivery(
      [row("delivery", "2026-10-09T18:00:00Z", ["mb-1"])],
      "mb-3",
      NOW,
      [{ file: BOX, lines: lines("mb-1", "mb-2", "mb-3") }]
    );
    expect(result.untracked).toBe(false);
  });

  /** 古い行がどこかにあるだけでは出さない（以前の誤り） */
  test("郵便受けに書かれていなければ、id を記録しない頃の便とは言わない", () => {
    const result = lookupDelivery(
      [{ kind: "delivery", at: "2026-10-08T14:22:56Z", title: "受付", count: 1 }],
      "mb-honntai-5",
      NOW,
      []
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
      NOW
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
      NOW
    );
    expect(result.status).toBe("not-found");
    expect(result.hints.map((h) => h.kind)).toEqual(["trigger-capped", "trigger-rejected"]);
  });
});

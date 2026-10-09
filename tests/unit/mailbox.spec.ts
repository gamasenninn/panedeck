import { test, expect } from "@playwright/test";
import path from "path";
import { desiredMailboxes, mailboxFile, MAILBOX_LIMIT } from "../../lib/mailbox";

/**
 * 郵便受けをペインごとに自動で作る（#34、2026-10-10）。
 *
 * 手で設定に書いていたときは、ペインを足すたびに設定を書き換えて再起動が要り、
 * **上限（limit）を付け忘れても気づけなかった**。付け忘れた郵便受けには
 * 起こし合いの歯止めが無い。
 *
 * ここは「題の一覧から、どの郵便受けが要るか」を決めるだけ。ファイルを作るのも
 * トリガーへ足すのも呼び出し側。
 */
const DIR = path.join("C:", "deck", "mailbox");

test.describe("mailboxFile", () => {
  test("題をそのままファイル名にする", () => {
    expect(mailboxFile(DIR, "受付")).toBe(path.join(DIR, "受付.jsonl"));
  });

  test("ファイル名に使えない文字は _ にする", () => {
    expect(mailboxFile(DIR, 'a/b:c*?"<>|')).toBe(path.join(DIR, "a_b_c______.jsonl"));
  });
});

test.describe("desiredMailboxes", () => {
  test("題ごとに 1 つ。送り先は題、上限を必ず付ける", () => {
    const [box] = desiredMailboxes({ titles: ["受付"], dir: DIR });
    expect(box.watch).toBe(path.join(DIR, "受付.jsonl"));
    expect(box.pane).toEqual({ title: "受付" });
    expect(box.limit).toEqual(MAILBOX_LIMIT);
    expect(MAILBOX_LIMIT).toEqual({ count: 6, minutes: 10 });
  });

  /** ★ 文面のパスはスラッシュで書く。円記号は引用を通るたびに消える（10/9 に踏んだ） */
  test("文面に郵便受けのパスをスラッシュで入れる", () => {
    const [box] = desiredMailboxes({ titles: ["受付"], dir: DIR });
    expect(box.send).toContain(path.join(DIR, "受付.jsonl").split(path.sep).join("/"));
    expect(box.send).not.toContain("\\");
    expect(box.send).toContain("{count}");
    expect(box.send).toContain("{id}");
  });

  test("文面を差し替えられる。{file} が郵便受けのパスになる", () => {
    const [box] = desiredMailboxes({ titles: ["受付"], dir: DIR, send: "mail {count} at {file}" });
    expect(box.send).toBe(`mail {count} at ${path.join(DIR, "受付.jsonl").split(path.sep).join("/")}`);
  });

  /** 宛先が決まらない。作るとツールバーに「同じ題が 2 つ」が出続ける */
  test("同じ題のペインが 2 つ以上なら作らない", () => {
    const boxes = desiredMailboxes({ titles: ["panedeck", "受付", "panedeck"], dir: DIR });
    expect(boxes.map((b) => b.pane.title)).toEqual(["受付"]);
  });

  /** 違う題が同じファイル名になると、片方には永久に届かない。どちらも作らない */
  test("ファイル名が重なる題はどちらも作らない", () => {
    const boxes = desiredMailboxes({ titles: ["a/b", "a_b", "受付"], dir: DIR });
    expect(boxes.map((b) => b.pane.title)).toEqual(["受付"]);
  });

  test("空の題には作らない", () => {
    expect(desiredMailboxes({ titles: ["", "  "], dir: DIR })).toEqual([]);
  });

  /** 手で書いたトリガーが見ているファイルは、二重に配らない */
  test("既に見張られているファイルには作らない", () => {
    const boxes = desiredMailboxes({
      titles: ["本体", "受付"],
      dir: DIR,
      taken: [path.join(DIR, "本体.jsonl")],
    });
    expect(boxes.map((b) => b.pane.title)).toEqual(["受付"]);
  });
});

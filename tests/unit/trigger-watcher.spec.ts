import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  TriggerWatcher,
  SUBMIT_DELAY_MS,
  CONFIRM_MS,
  MAX_SUBMITS,
} from "../../lib/trigger-watcher";

/**
 * ファイルが伸びたら、指示待ちのペインへ 1 通送る（#28）。
 *
 * ここでは「いつ・何を・何通」送るかだけを見る。ファイルの監視も pty への
 * 書き込みも外から注入するので、実ファイルの更新通知にも Electron にも
 * 依存しない。
 */

function tempFile(contents = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-trigger-"));
  const file = path.join(dir, "queue.jsonl");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

/**
 * **打つことと確定することは別の出来事**なので、ヘルパも分けて記録する。
 * 時計も差し替える —— 確定までの間隔を実時間で待たないため。
 */
function setup(options: Record<string, unknown> = {}) {
  const sent: Array<{ title: string; text: string }> = [];
  const submits: string[] = [];
  let status = "ready";
  let clock = 1000;

  const watcher = new TriggerWatcher({
    findPane: (title: string) =>
      title === "missing" ? [] : [{ id: "s1", title, status }],
    type: (id: string, text: string) => sent.push({ title: id, text }),
    submit: (id: string) => submits.push(id),
    now: () => clock,
    ...options,
  });

  const advance = (ms: number) => {
    clock += ms;
  };
  const setStatus = (s: string) => {
    status = s;
  };

  /**
   * 打つ → 確定 → 実行の確認、までを一気に進める。
   *
   * 1 回の `check()` では終わらない。実アプリは 300ms ごとに呼ぶので、
   * テストでも同じように何度か呼ぶ。
   */
  const runHandshake = () => {
    watcher.check(); // 打つ
    advance(SUBMIT_DELAY_MS);
    watcher.check(); // 確定
    setStatus("running"); // ペインが動いた＝実行された
    watcher.check(); // 確認
    setStatus("ready");
  };

  return { watcher, sent, submits, setStatus, advance, runHandshake };
}

test.describe("届け方", () => {
  test("新しい行が増えたら指示待ちのペインへ送る", () => {
    const file = tempFile("");
    const { watcher, sent } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "new {count}" });

    fs.appendFileSync(file, '{"id":"x1"}\n');
    watcher.check();

    expect(sent).toEqual([{ title: "s1", text: "new 1" }]);
  });

  test("最初から入っていた行は送らない（追いかけるのは増分だけ）", () => {
    const file = tempFile('{"id":"old"}\n');
    const { watcher, sent } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "new {count}" });

    watcher.check();
    expect(sent).toEqual([]);
  });

  /** 1 行ごとに送ると、まとめて届いたときに同じ数だけ割り込むことになる */
  test("保留した行はまとめて 1 通にする", () => {
    const file = tempFile("");
    const { watcher, sent, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count} 件 last={id}" });

    setStatus("running");
    fs.appendFileSync(file, '{"id":"x1"}\n{"id":"x2"}\n');
    watcher.check();
    expect(sent).toEqual([]);

    fs.appendFileSync(file, '{"id":"x3"}\n');
    watcher.check();
    expect(sent).toEqual([]);

    setStatus("ready");
    watcher.check();
    expect(sent).toEqual([{ title: "s1", text: "3 件 last=x3" }]);
  });

  test("送ったら保留は空になる（同じものを二度送らない）", () => {
    const file = tempFile("");
    const { watcher, sent } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();
    watcher.check();

    expect(sent).toHaveLength(1);
  });

  /** 確認待ちへ送ると、打った文字が指示ではなく回答になる（#27） */
  test("確認待ちのペインには送らない", () => {
    const file = tempFile("");
    const { watcher, sent, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("asking");
    fs.appendFileSync(file, "one\n");
    watcher.check();

    expect(sent).toEqual([]);
  });

  /** 判別できない waiting も対象外。見分けられない以上「送ってよい」と言えない */
  test("判別できない入力待ちにも送らない", () => {
    const file = tempFile("");
    const { watcher, sent, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("waiting");
    fs.appendFileSync(file, "one\n");
    watcher.check();

    expect(sent).toEqual([]);
  });
});

test.describe("見えること", () => {
  test("保留の件数が分かる", () => {
    const file = tempFile("");
    const { watcher, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("running");
    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

    expect(watcher.state()[0].held).toBe(2);
  });

  test("ファイルが無ければそう言う", () => {
    const { watcher } = setup();
    watcher.add({ watch: "C:\no\such\file.jsonl", pane: { title: "a" }, send: "x" });
    watcher.check();

    expect(watcher.state()[0].error).toContain("ファイル");
  });

  test("ペインが無ければそう言う", () => {
    const file = tempFile("");
    const { watcher } = setup();
    watcher.add({ watch: file, pane: { title: "missing" }, send: "x" });
    watcher.check();

    expect(watcher.state()[0].error).toContain("ペイン");
  });

  /** 同じ題のペインが 2 つあるときは、どちらへ送るか決められない */
  test("ペインが 2 つ当たればエラー（手当たり次第に送らない）", () => {
    const file = tempFile("");
    const { watcher, sent } = setup({
      findPane: (title: string) => [
        { id: "s1", title, status: "ready" },
        { id: "s2", title, status: "ready" },
      ],
    });
    watcher.add({ watch: file, pane: { title: "a" }, send: "x" });

    fs.appendFileSync(file, "one\n");
    watcher.check();

    expect(sent).toEqual([]);
    expect(watcher.state()[0].error).toContain("2");
  });
});

test.describe("カーソル", () => {
  test("どこまで届けたかを取り出せる", () => {
    const file = tempFile("");
    const { watcher, runHandshake } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    // 打つ → 確定 → 実行の確認。**送った時点では進まない**
    runHandshake();

    expect(watcher.cursors()[file]).toBe(8); // "one\ntwo\n"
  });

  /** 閉じている間に増えた行は、次に開いたときに届く（飛ばさない） */
  test("預けたカーソルから再開する", () => {
    const file = tempFile("one\n");
    const { watcher, sent } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" }, 0);

    watcher.check();
    expect(sent).toEqual([{ title: "s1", text: "1" }]);
  });

  test("ファイルが短くなったら先頭から読み直す（入れ替わった扱い）", () => {
    const file = tempFile("one\ntwo\n");
    const { watcher, sent } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });
    watcher.check();

    fs.writeFileSync(file, "fresh\n");
    watcher.check();

    expect(sent).toEqual([{ title: "s1", text: "1" }]);
  });
});

/**
 * カーソルは「読んだ位置」ではなく「**届けた位置**」（#28 の dogfood で気づいた）。
 *
 * 読んだ時点で進めると、保留したまま閉じた行が次の起動で飛ばされる。
 * 保留はメモリにしか無いので、記録にも残らず消える。
 */
test.describe("保留中のカーソル", () => {
  test("届けるまでカーソルは進まない", () => {
    const file = tempFile("");
    const { watcher, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("running");
    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

    expect(watcher.state()[0].held).toBe(2);
    expect(watcher.cursors()[file]).toBe(0);
  });

  test("届けた時点で進む", () => {
    const file = tempFile("");
    const { watcher, setStatus, runHandshake } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("running");
    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

    // 動けるようになってから、打つ → 確定 → 確認
    setStatus("ready");
    runHandshake();
    expect(watcher.cursors()[file]).toBe(8);
  });

  /** 閉じて開き直しても、保留していた行は消えずに届く */
  test("保留したまま閉じても、次の起動で届く", () => {
    const file = tempFile("");
    const first = setup();
    first.watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    first.setStatus("running");
    fs.appendFileSync(file, "one\ntwo\n");
    first.watcher.check();
    const saved = first.watcher.cursors()[file];

    // 預けたカーソルで開き直す
    const second = setup();
    second.watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" }, saved);
    second.watcher.check();

    expect(second.sent).toEqual([{ title: "s1", text: "2" }]);
  });
});

/**
 * 打つことと、確定することは別の出来事（#28 の dogfood で分かった）。
 *
 * 文面と確定の CR を一度に書くと、Claude Code は貼り付けと見て CR を
 * **改行として入れる** —— 文面は入力欄に残り、実行されない。実測では
 * 91 文字の文面で**一度に送ると 0/4、分けて送ると 4/4**。
 *
 * 短い文面では起きないので、長さで変わる。そして**人が手で操作している
 * 限り出ない** —— 人は「文字を入れる」「Enter を押す」を別々にやっている。
 */
test.describe("打つのと確定するのを分ける", () => {
  test("打った直後には確定しない", () => {
    const file = tempFile("");
    const { watcher, sent, submits } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();

    expect(sent).toEqual([{ title: "s1", text: "1" }]);
    expect(submits).toEqual([]);
  });

  test("間隔を越えてから確定する", () => {
    const file = tempFile("");
    const { watcher, submits, advance } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();

    // 間隔に足りないうちは押さない
    advance(SUBMIT_DELAY_MS - 1);
    watcher.check();
    expect(submits).toEqual([]);

    advance(1);
    watcher.check();
    expect(submits).toEqual(["s1"]);
  });

  test("確定は一度だけ（実行されれば押し直さない）", () => {
    const file = tempFile("");
    const { watcher, submits, advance, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();
    advance(SUBMIT_DELAY_MS);
    watcher.check();

    setStatus("running");
    advance(CONFIRM_MS * 3);
    watcher.check();
    watcher.check();

    expect(submits).toEqual(["s1"]);
  });
});

/**
 * 送っただけでは届いたと言わない。
 *
 * 以前は書いた時点でカーソルを進めていた。実行されなければ行は消費され、
 * 文面は入力欄に残り、何も起きない —— **この機能が取り除こうとした
 * 「黙って何もしない」そのもの**だった。
 */
test.describe("実行を確かめてからカーソルを進める", () => {
  test("確定しただけではカーソルは進まない", () => {
    const file = tempFile("");
    const { watcher, advance } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();
    advance(SUBMIT_DELAY_MS);
    watcher.check();

    expect(watcher.cursors()[file]).toBe(0);
    // 確認中の行も「まだ届いていない」と数える
    expect(watcher.state()[0].held).toBe(2);
  });

  test("ペインが動いたら進む", () => {
    const file = tempFile("");
    const { watcher, advance, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();
    advance(SUBMIT_DELAY_MS);
    watcher.check();

    setStatus("running");
    watcher.check();

    expect(watcher.cursors()[file]).toBe(8);
    expect(watcher.state()[0].held).toBe(0);
  });

  test("動かないままなら確定を押し直す", () => {
    const file = tempFile("");
    const { watcher, submits, advance } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();
    advance(SUBMIT_DELAY_MS);
    watcher.check();
    expect(submits).toHaveLength(1);

    advance(CONFIRM_MS);
    watcher.check();
    expect(submits).toHaveLength(2);
  });

  /** 押し続けて諦めるまでに、行を失わないこと */
  test("諦めても行は保留に戻る（消えない）", () => {
    const file = tempFile("");
    const { watcher, submits, advance } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();
    for (let i = 0; i < MAX_SUBMITS + 2; i++) {
      advance(Math.max(SUBMIT_DELAY_MS, CONFIRM_MS));
      watcher.check();
    }

    expect(submits).toHaveLength(MAX_SUBMITS);
    expect(watcher.state()[0].held).toBe(2);
    expect(watcher.cursors()[file]).toBe(0);
    expect(watcher.state()[0].error).toContain("実行されませんでした");
  });

  /** 入力欄に文面が残っているので、重ねて打つと繋がって意味をなさない */
  test("諦めた後、ペインが動くまで打ち直さない", () => {
    const file = tempFile("");
    const { watcher, sent, advance, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\n");
    watcher.check();
    for (let i = 0; i < MAX_SUBMITS + 2; i++) {
      advance(Math.max(SUBMIT_DELAY_MS, CONFIRM_MS));
      watcher.check();
    }
    expect(sent).toHaveLength(1);

    // 指示待ちのままでは打ち直さない
    fs.appendFileSync(file, "two\n");
    watcher.check();
    expect(sent).toHaveLength(1);

    // ペインが動けば詰まりが解けたとみなす
    setStatus("running");
    watcher.check();
    setStatus("ready");
    watcher.check();
    expect(sent).toHaveLength(2);
  });

  test("確認中にペインが消えたら、行は保留に戻る", () => {
    const file = tempFile("");
    let title = "a";
    const { watcher, advance } = setup({
      findPane: () => (title === "a" ? [{ id: "s1", title: "a", status: "ready" }] : []),
    });
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

    title = "gone";
    advance(SUBMIT_DELAY_MS);
    watcher.check();

    expect(watcher.state()[0].held).toBe(2);
    expect(watcher.cursors()[file]).toBe(0);
  });
});

import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { TriggerWatcher } from "../../lib/trigger-watcher";

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

function setup(options: Record<string, unknown> = {}) {
  const sent: Array<{ title: string; text: string }> = [];
  let status = "ready";

  const watcher = new TriggerWatcher({
    findPane: (title: string) =>
      title === "missing" ? [] : [{ id: "s1", title, status }],
    send: (id: string, text: string) => sent.push({ title: id, text }),
    ...options,
  });

  return { watcher, sent, setStatus: (s: string) => (status = s) };
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
    const { watcher } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

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
    const { watcher, setStatus } = setup();
    watcher.add({ watch: file, pane: { title: "a" }, send: "{count}" });

    setStatus("running");
    fs.appendFileSync(file, "one\ntwo\n");
    watcher.check();

    setStatus("ready");
    watcher.check();
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

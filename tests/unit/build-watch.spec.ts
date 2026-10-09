import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { BuildWatch } from "../../lib/build-watch";

/**
 * **動いている PaneDeck が古いかを、画面で分かるようにする**（2026-10-10）。
 *
 * 修正のたびに「次に再起動したときに効く」と言い、再起動して、新しいビルドで
 * 動いているかを道具で確かめる、を 1 日に 10 回近くくり返した。一度は「再起動した」
 * のにプロセスが前のままだった。古いデッキは設定を書き戻すときに知らない項目を
 * 消すので、再起動の段取りまで人に頼む必要があった。
 *
 * ★ **中身で比べる。** 試験（npm test）は毎回ビルドし直すので、中身が同じでも
 * 更新日時は変わる。日時で見ると、試験を回すたびに「新しいビルドあり」が出る。
 * 日時は「比べ直すかどうか」の目安にだけ使う。
 */
function buildDir(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-build-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text, "utf8");
  }
  return dir;
}

function touchLater(file: string) {
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(file, later, later);
}

test("起動したときのままなら、古くない", () => {
  const dir = buildDir({ "main.js": "a", "lib/x.js": "b" });
  const watch = new BuildWatch(dir);
  expect(watch.stale()).toBe(false);
});

test("中身が変わったら、古い", () => {
  const dir = buildDir({ "main.js": "a", "lib/x.js": "b" });
  const watch = new BuildWatch(dir);

  fs.writeFileSync(path.join(dir, "lib", "x.js"), "changed", "utf8");
  touchLater(path.join(dir, "lib", "x.js"));

  expect(watch.stale()).toBe(true);
});

/** ★ 試験のたびのビルドで出ないこと（日時だけ変わって中身は同じ） */
test("日時だけ変わって中身が同じなら、古くない", () => {
  const dir = buildDir({ "main.js": "a", "lib/x.js": "b" });
  const watch = new BuildWatch(dir);

  fs.writeFileSync(path.join(dir, "main.js"), "a", "utf8");
  touchLater(path.join(dir, "main.js"));

  expect(watch.stale()).toBe(false);
});

test("ファイルが増えたら、古い", () => {
  const dir = buildDir({ "main.js": "a" });
  const watch = new BuildWatch(dir);

  fs.writeFileSync(path.join(dir, "new.js"), "n", "utf8");

  expect(watch.stale()).toBe(true);
});

/** 一度古くなったら、元に戻されても古いまま（動いているのは起動時の中身） */
test("一度古いと分かったら、そのまま古いと答える", () => {
  const dir = buildDir({ "main.js": "a" });
  const watch = new BuildWatch(dir);
  fs.writeFileSync(path.join(dir, "main.js"), "b", "utf8");
  touchLater(path.join(dir, "main.js"));
  expect(watch.stale()).toBe(true);

  fs.writeFileSync(path.join(dir, "main.js"), "a", "utf8");
  expect(watch.stale()).toBe(true);
});

/** 読めない場所（パッケージ版の中など）では、何も言わない。落ちない */
test("ビルドの置き場が読めなければ、古くないと答えて落ちない", () => {
  const watch = new BuildWatch(path.join(os.tmpdir(), "no-such-panedeck-build"));
  expect(watch.stale()).toBe(false);
});

/** .js だけを見る（.map や .d.ts の出入りで騒がない） */
test("js 以外のファイルの変化は見ない", () => {
  const dir = buildDir({ "main.js": "a" });
  const watch = new BuildWatch(dir);
  fs.writeFileSync(path.join(dir, "main.js.map"), "m", "utf8");
  expect(watch.stale()).toBe(false);
});

import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { EventLog } from "../../lib/event-log";
import { readIndex } from "../../lib/log-retention";
import { logFileName } from "../../lib/log-writer";

/**
 * 出来事の記録（#36）。
 *
 * **見せるだけでは残らない。** ツールバーはいまの状態を描き直す表示なので、
 * 直れば証拠が消え、閉じれば全部消える。夜中に「ペインがありません」が出て
 * いても、後から知る術がなかった。
 *
 * ここは**出来事だけ**を 1 行ずつ残す。毎周の状態は書かない（300ms × 枚数を
 * 書くと読めない量になる）。静かな日はほぼ何も増えないのが狙い。
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-events-"));
}

/**
 * ★ **時間帯を固定する。**
 *
 * ファイル名の日付は**ローカル時刻**で切る（ペインの記録と同じ）。固定しないと、
 * この仕様を見る試験が **CI（UTC）では常に通ってしまう** —— ローカルと UTC が
 * 一致する場所では、どちらの実装でも同じ名前になるため。実際に UTC で切る実装が
 * 1 日ぶん紛れ込んだ（#36 の取りこぼし）。
 *
 * 固定しておけば、どの開発機でも CI でも同じ日の境目を見る。
 */
const TZ = "Asia/Tokyo";
let savedTZ: string | undefined;

test.beforeAll(() => {
  savedTZ = process.env.TZ;
  process.env.TZ = TZ;
});

test.afterAll(() => {
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
});

/** ローカル時刻の年月日時分秒から瞬間を作る */
function at(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0
): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function setup(options: Record<string, unknown> = {}) {
  const dir = tempDir();
  let clock = at(2026, 10, 6, 10, 2, 3);
  const log = new EventLog({
    dir,
    now: () => clock,
    ...options,
  });
  return { dir, log, advance: (ms: number) => (clock += ms) };
}

function linesIn(dir: string, name: string) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test.describe("書く場所", () => {
  test("日付入りのファイルに追記する", () => {
    const { dir, log } = setup();
    log.write({ kind: "delivery", title: "受付", count: 2 });

    const files = fs.readdirSync(dir);
    expect(files).toContain("events-20261006.jsonl");

    const [row] = linesIn(dir, "events-20261006.jsonl");
    expect(row.kind).toBe("delivery");
    expect(row.title).toBe("受付");
    expect(row.count).toBe(2);
    expect(row.at).toBe("2026-10-06T01:02:03.000Z"); // 10:02:03 JST の瞬間
  });

  test("日が変わったら別のファイルへ", () => {
    const { dir, log, advance } = setup();
    log.write({ kind: "a" });
    advance(24 * 3600 * 1000);
    log.write({ kind: "b" });

    expect(linesIn(dir, "events-20261006.jsonl")).toHaveLength(1);
    expect(linesIn(dir, "events-20261007.jsonl")).toHaveLength(1);
  });

  test("同じ日なら同じファイルに積む", () => {
    const { dir, log, advance } = setup();
    log.write({ kind: "a" });
    advance(3600 * 1000);
    log.write({ kind: "b" });

    expect(linesIn(dir, "events-20261006.jsonl")).toHaveLength(2);
  });

  /**
   * ★ **日の境目はローカルの深夜。**
   *
   * `log-writer` のファイル名はローカル時刻で付く。同じフォルダに並ぶのだから、
   * ここも同じ日で切らないと、**1 つの折に 2 つの日付が立つ**。
   *
   * JST では UTC で切ると `events-20261006.jsonl` が
   * **10/6 09:00 〜 10/7 09:00（JST）** を抱え、朝 8 時に「今日」を読もうとすると
   * 昨日の名前のファイルを開くことになる。#36 は「後から 1 日を読む」ための
   * 記録なので、名前の日付がずれるのは機能そのものの欠けになる。
   */
  test("ローカルの深夜で日が変わる", () => {
    const { dir, log } = setup({ now: () => at(2026, 10, 7, 0, 0, 1) });
    log.write({ kind: "a" });

    expect(fs.readdirSync(dir)).toContain("events-20261007.jsonl");
  });

  test("ローカルの深夜直前はまだ前の日", () => {
    const { dir, log } = setup({ now: () => at(2026, 10, 6, 23, 59, 59) });
    log.write({ kind: "a" });

    expect(fs.readdirSync(dir)).toContain("events-20261006.jsonl");
  });

  /**
   * ★ **ペインの記録と同じ日付になること**を、片方の実装を写さずに確かめる。
   * 名前の付け方を変えたときに、2 つが別々に動くのを防ぐ。
   */
  test("ペインの記録と同じ日付で切る", () => {
    const moment = at(2026, 10, 7, 2, 30, 0); // UTC では前日
    const { dir, log } = setup({ now: () => moment });
    log.write({ kind: "a" });

    const paneDay = logFileName("受付", moment).match(/-(\d{8})-/)?.[1];
    const eventDay = fs
      .readdirSync(dir)
      .find((f) => f.startsWith("events-"))
      ?.match(/events-(\d{8})\.jsonl/)?.[1];

    expect(eventDay).toBe(paneDay);
  });

  /** ディレクトリが無くても作る（初回起動） */
  test("出力先が無ければ作る", () => {
    const dir = path.join(tempDir(), "まだ無い");
    const log = new EventLog({ dir, now: () => at(2026, 10, 6) });
    log.write({ kind: "a" });

    expect(fs.existsSync(path.join(dir, "events-20261006.jsonl"))).toBe(true);
  });
});

test.describe("壊れても配達を止めない", () => {
  /**
   * **記録が書けないことで、届けるのをやめてはいけない。**
   * 記録は後から読むためのもので、配達より大事なものではない。
   */
  test("書けなくても例外を投げない", () => {
    const { log } = setup({
      append: () => {
        throw new Error("書けません");
      },
    });

    expect(() => log.write({ kind: "a" })).not.toThrow();
  });

  test("書けなかった回数は数えておく（黙って捨てない）", () => {
    const { log } = setup({
      append: () => {
        throw new Error("書けません");
      },
    });
    log.write({ kind: "a" });
    log.write({ kind: "b" });

    expect(log.failed).toBe(2);
  });
});

test.describe("片付けの対象にする", () => {
  /** 索引に載っているものしか消されない（lib/log-retention） */
  test("索引を渡せば登録する", () => {
    const dir = tempDir();
    const indexPath = path.join(dir, ".panedeck-logs.json");
    const log = new EventLog({ dir, indexPath, now: () => at(2026, 10, 6) });

    log.write({ kind: "a" });

    const entries = readIndex(indexPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe(path.join(dir, "events-20261006.jsonl"));
  });

  test("同じ日に何度書いても索引は 1 件", () => {
    const dir = tempDir();
    const indexPath = path.join(dir, ".panedeck-logs.json");
    const log = new EventLog({ dir, indexPath, now: () => at(2026, 10, 6) });

    log.write({ kind: "a" });
    log.write({ kind: "b" });
    log.write({ kind: "c" });

    expect(readIndex(indexPath)).toHaveLength(1);
  });

  test("索引を渡さなければ登録しない（片付けの対象外）", () => {
    const { dir, log } = setup();
    log.write({ kind: "a" });

    expect(fs.existsSync(path.join(dir, ".panedeck-logs.json"))).toBe(false);
  });
});

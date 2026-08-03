import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  DAY_MS,
  readIndex,
  addToIndex,
  selectForDeletion,
  cleanupLogs,
} from "../../lib/log-retention";

const TEMP_DIR = path.join(__dirname, "temp-retention");
const INDEX = () => path.join(TEMP_DIR, ".panedeck-logs.json");

/** 2026-08-03 12:00:00 相当の固定時刻 */
const NOW = 1_785_000_000_000;

test.beforeEach(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

/** 実ファイルを作り、索引にも載せる */
function givenLog(name: string, { ageDays = 0, bytes = 100 } = {}) {
  const filePath = path.join(TEMP_DIR, name);
  fs.writeFileSync(filePath, "x".repeat(bytes), "utf8");
  addToIndex(INDEX(), filePath, NOW - ageDays * DAY_MS);
  return filePath;
}

const noLimit = { maxAgeDays: 0, maxTotalBytes: 0 };

test.describe("selectForDeletion", () => {
  const entry = (file: string, ageDays: number, size: number) => ({
    file,
    createdAt: NOW - ageDays * DAY_MS,
    size,
  });

  test("保持期間を過ぎたものを選ぶ", () => {
    const entries = [entry("old.log", 40, 10), entry("new.log", 5, 10)];
    const remove = selectForDeletion(entries, { maxAgeDays: 30, maxTotalBytes: 0 }, NOW);

    expect(remove).toEqual(["old.log"]);
  });

  test("ちょうど境界のものは残す", () => {
    const entries = [entry("edge.log", 30, 10)];
    expect(
      selectForDeletion(entries, { maxAgeDays: 30, maxTotalBytes: 0 }, NOW)
    ).toEqual([]);
  });

  test("maxAgeDays が 0 なら期間では消さない", () => {
    const entries = [entry("ancient.log", 3650, 10)];
    expect(selectForDeletion(entries, noLimit, NOW)).toEqual([]);
  });

  test("合計サイズを超えたら古い順に消す", () => {
    const entries = [
      entry("a.log", 3, 100),
      entry("b.log", 2, 100),
      entry("c.log", 1, 100),
    ];
    // 上限 250 → 一番古い a を消せば 200 で収まる
    const remove = selectForDeletion(
      entries,
      { maxAgeDays: 0, maxTotalBytes: 250 },
      NOW
    );

    expect(remove).toEqual(["a.log"]);
  });

  test("1 つ消しても足りなければ次の古いものも消す", () => {
    const entries = [
      entry("a.log", 3, 100),
      entry("b.log", 2, 100),
      entry("c.log", 1, 100),
    ];
    const remove = selectForDeletion(
      entries,
      { maxAgeDays: 0, maxTotalBytes: 150 },
      NOW
    );

    expect(remove).toEqual(["a.log", "b.log"]);
  });

  test("新しいものは最後まで残す", () => {
    const entries = [entry("a.log", 3, 100), entry("newest.log", 1, 100)];
    const remove = selectForDeletion(
      entries,
      { maxAgeDays: 0, maxTotalBytes: 1 },
      NOW
    );

    // 上限より大きくても、最新の 1 つは残す（消しても意味が無い）
    expect(remove).toEqual(["a.log"]);
  });

  test("maxTotalBytes が 0 ならサイズでは消さない", () => {
    const entries = [entry("big.log", 1, 999_999_999)];
    expect(selectForDeletion(entries, noLimit, NOW)).toEqual([]);
  });

  test("両方の条件が重なっても重複して返さない", () => {
    const entries = [entry("old-big.log", 90, 1000), entry("new.log", 1, 10)];
    const remove = selectForDeletion(
      entries,
      { maxAgeDays: 30, maxTotalBytes: 500 },
      NOW
    );

    expect(remove).toEqual(["old-big.log"]);
  });

  test("空でも落ちない", () => {
    expect(selectForDeletion([], { maxAgeDays: 30, maxTotalBytes: 100 }, NOW)).toEqual(
      []
    );
  });
});

test.describe("索引", () => {
  test("無ければ空を返す", () => {
    expect(readIndex(path.join(TEMP_DIR, "missing.json"))).toEqual([]);
  });

  test("壊れていても空を返す（例外にしない）", () => {
    fs.writeFileSync(INDEX(), "{ これは JSON ではない", "utf8");
    expect(() => readIndex(INDEX())).not.toThrow();
    expect(readIndex(INDEX())).toEqual([]);
  });

  test("追加した順に読み戻せる", () => {
    addToIndex(INDEX(), path.join(TEMP_DIR, "a.log"), NOW);
    addToIndex(INDEX(), path.join(TEMP_DIR, "b.log"), NOW + 1);

    expect(readIndex(INDEX()).map((e) => path.basename(e.file))).toEqual([
      "a.log",
      "b.log",
    ]);
  });

  test("同じファイルを二重に載せない", () => {
    const file = path.join(TEMP_DIR, "a.log");
    addToIndex(INDEX(), file, NOW);
    addToIndex(INDEX(), file, NOW + 1000);

    expect(readIndex(INDEX())).toHaveLength(1);
  });

  test("追加に失敗しても例外を投げない", () => {
    // 索引の置き場所をファイルで塞ぐ
    const blocked = path.join(TEMP_DIR, "blocked");
    fs.writeFileSync(blocked, "not a dir", "utf8");

    expect(() =>
      addToIndex(path.join(blocked, "index.json"), "x.log", NOW)
    ).not.toThrow();
  });
});

test.describe("cleanupLogs", () => {
  test("期限切れのログを消す", () => {
    const old = givenLog("old-20260101-000000.log", { ageDays: 90 });
    const fresh = givenLog("new-20260803-000000.log", { ageDays: 1 });

    const result = cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 30, maxTotalBytes: 0 },
      now: () => NOW,
    });

    expect(result.deleted).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test("索引に無いファイルは同じ場所にあっても消さない", () => {
    // ここが本題。ユーザーが出力先に置いた別のファイルを巻き込まない
    givenLog("mine-20260101-000000.log", { ageDays: 90 });

    // 名前の形まで同じだが、PaneDeck が作ったものではない
    const lookalike = path.join(TEMP_DIR, "theirs-20200101-000000.log");
    fs.writeFileSync(lookalike, "user's own file", "utf8");
    const unrelated = path.join(TEMP_DIR, "notes.txt");
    fs.writeFileSync(unrelated, "important", "utf8");

    cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 30, maxTotalBytes: 0 },
      now: () => NOW,
    });

    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test("消したものは索引から外す", () => {
    givenLog("old-20260101-000000.log", { ageDays: 90 });
    givenLog("new-20260803-000000.log", { ageDays: 1 });

    cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 30, maxTotalBytes: 0 },
      now: () => NOW,
    });

    expect(readIndex(INDEX()).map((e) => path.basename(e.file))).toEqual([
      "new-20260803-000000.log",
    ]);
  });

  test("既に消えているファイルは索引から外すだけ", () => {
    const gone = givenLog("gone-20260803-000000.log", { ageDays: 1 });
    fs.rmSync(gone);

    const result = cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 30, maxTotalBytes: 0 },
      now: () => NOW,
    });

    expect(result.deleted).toEqual([]);
    expect(readIndex(INDEX())).toEqual([]);
  });

  test("上限が両方 0 なら何もしない（片付けの無効化）", () => {
    const ancient = givenLog("ancient-20200101-000000.log", { ageDays: 3650 });

    const result = cleanupLogs({
      indexPath: INDEX(),
      policy: noLimit,
      now: () => NOW,
    });

    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(ancient)).toBe(true);
  });

  test("索引が壊れていても落ちず、何も消さない", () => {
    const file = givenLog("a-20260803-000000.log", { ageDays: 90 });
    fs.writeFileSync(INDEX(), "壊れた索引", "utf8");

    expect(() =>
      cleanupLogs({
        indexPath: INDEX(),
        policy: { maxAgeDays: 30, maxTotalBytes: 0 },
        now: () => NOW,
      })
    ).not.toThrow();

    // 索引が読めない＝自分が作った証拠が無いので、消してはいけない
    expect(fs.existsSync(file)).toBe(true);
  });

  test("削除に失敗しても他は続け、失敗を返す", () => {
    const locked = givenLog("locked-20260101-000000.log", { ageDays: 90 });
    const ok = givenLog("ok-20260101-000000.log", { ageDays: 90 });

    // ファイルをディレクトリに置き換えると unlink が失敗する
    fs.rmSync(locked);
    fs.mkdirSync(locked);

    const result = cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 30, maxTotalBytes: 0 },
      now: () => NOW,
    });

    expect(result.deleted).toEqual([ok]);
    expect(result.failed.map((f) => f.file)).toEqual([locked]);
    expect(fs.existsSync(ok)).toBe(false);
  });

  test("合計サイズでも消える", () => {
    givenLog("a-20260101-000000.log", { ageDays: 3, bytes: 1000 });
    const keep = givenLog("b-20260102-000000.log", { ageDays: 1, bytes: 1000 });

    const result = cleanupLogs({
      indexPath: INDEX(),
      policy: { maxAgeDays: 0, maxTotalBytes: 1500 },
      now: () => NOW,
    });

    expect(result.deleted).toHaveLength(1);
    expect(fs.existsSync(keep)).toBe(true);
  });
});

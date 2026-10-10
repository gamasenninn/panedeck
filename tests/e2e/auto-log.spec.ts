import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  resetSessions,
  openSettings,
  closeSettings,
  waitForPaneCount,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-auto-log");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const LOG_DIR = path.join(TEMP_DIR, "logs");

let electronApp: ElectronApplication;
let page: Page;

/** アプリが動いているか。テストの中で閉じた分を二重に閉じないための目印 */
let running = false;

/** 設定ファイルを直接書いてからアプリを起動する。 */
async function launchWith(settings: Record<string, unknown>) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), "utf8");

  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
  running = true;
}

async function relaunchWith(settings: Record<string, unknown>) {
  if (running) await closeApp(electronApp);
  await launchWith(settings);
}

/**
 * 出力先にあるログファイル。
 *
 * 片付け用の索引（.panedeck-logs.json）はログではないので数えない。
 */
function logFiles(dir = LOG_DIR) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.endsWith(".log")).sort()
    : [];
}

function readLog(name: string, dir = LOG_DIR) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

const autoLogToggle = () => page.locator("[data-testid=auto-log]");

/** ログ自動保存は設定ダイアログの中にあるので、開いてから触る */
async function enableAutoLog() {
  await openSettings(page);
  await autoLogToggle().check();
  await closeSettings(page);
}

test.beforeAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.afterAll(async () => {
  if (running) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe("有効なとき", () => {
  test.beforeAll(async () => {
    await relaunchWith({ autoLog: true, logDir: LOG_DIR });
  });

  test("セッションの出力がファイルに書かれる", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "alpha" });
    await waitForPaneCount(page, 1);

    await emitPtyData(electronApp, 0, "building module 1\n");
    await emitPtyData(electronApp, 0, "done\n");

    await expect.poll(() => logFiles().length).toBe(1);

    // 出力は溜めてから定期的に流されるので、2 つの書き込みが同じ回で
    // 落ちるとは限らない。片方を待って片方を即座に見ると取りこぼす
    await expect
      .poll(() => readLog(logFiles()[0]))
      .toContain("building module 1");
    await expect.poll(() => readLog(logFiles()[0])).toContain("done");
  });

  test("ファイル名にタイトルと起動時刻が入る", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-b", title: "beta" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "x");

    await expect
      .poll(() => logFiles().some((n) => /^beta-\d{8}-\d{6}\.log$/.test(n)))
      .toBe(true);
  });

  test("セッションごとに別ファイルへ分かれる", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "one" });
    await createSession(page, { cwd: "C:\\app\\repo-b", title: "two" });
    await waitForPaneCount(page, 2);

    await emitPtyData(electronApp, 0, "AAA");
    await emitPtyData(electronApp, 1, "BBB");

    const named = (prefix: string) =>
      logFiles().find((n) => n.startsWith(`${prefix}-`));

    await expect.poll(() => Boolean(named("one") && named("two"))).toBe(true);
    await expect.poll(() => readLog(named("one")!)).toContain("AAA");
    await expect.poll(() => readLog(named("two")!)).toContain("BBB");
    // 混ざっていないこと。ここは待つ対象と見る対象が同じなので即座に見てよい
    expect(readLog(named("one")!)).not.toContain("BBB");
  });

  test("ANSI エスケープは既定で落とす", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "colored" });
    await waitForPaneCount(page, 1);

    await emitPtyData(electronApp, 0, "\x1b[31mred\x1b[0m plain");

    const named = () => logFiles().find((n) => n.startsWith("colored-"));
    await expect.poll(() => (named() ? readLog(named()!) : "")).toContain("red plain");
    expect(readLog(named()!)).not.toContain("\x1b[31m");
  });

  test("アプリを閉じてもファイルが残る", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "survivor" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "written before quit");

    const named = () => logFiles().find((n) => n.startsWith("survivor-"));
    await expect.poll(() => Boolean(named())).toBe(true);
    const name = named()!;

    await closeApp(electronApp);
    running = false;

    expect(fs.existsSync(path.join(LOG_DIR, name))).toBe(true);
    expect(readLog(name)).toContain("written before quit");
  });
});

test.describe("無効なとき", () => {
  test.beforeAll(async () => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    await relaunchWith({ autoLog: false, logDir: LOG_DIR });
  });

  test("ファイルは作られない（現行動作のまま）", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "silent" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "not written anywhere");

    // 書かれないことの確認なので、書かれる猶予を与えてから見る
    await expect(page.locator("[data-testid=pane-status]")).toBeVisible();
    expect(logFiles()).toEqual([]);
  });

  test("トグルで有効にすると、以降の出力から書かれる", async () => {
    await resetSessions(electronApp, page);
    await enableAutoLog();

    await createSession(page, { cwd: "C:\\app\\repo-a", title: "late" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "after enabling");

    const named = () => logFiles().find((n) => n.startsWith("late-"));
    await expect
      .poll(() => (named() ? readLog(named()!) : ""))
      .toContain("after enabling");
  });

  test("トグルの状態は保存される", async () => {
    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).autoLog)
      .toBe(true);
  });
});

test.describe("古いログの片付け", () => {
  const indexPath = () => path.join(LOG_DIR, ".panedeck-logs.json");

  /** 古いログを 1 件、索引に載せた状態で置く */
  function givenOldLog(name: string, ageDays: number) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const filePath = path.join(LOG_DIR, name);
    fs.writeFileSync(filePath, "old output", "utf8");

    const index = fs.existsSync(indexPath())
      ? JSON.parse(fs.readFileSync(indexPath(), "utf8"))
      : [];
    index.push({ file: filePath, createdAt: Date.now() - ageDays * 86400000 });
    fs.writeFileSync(indexPath(), JSON.stringify(index), "utf8");

    return filePath;
  }

  test("起動時に保持期間を過ぎたログが消える", async () => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    const old = givenOldLog("old-20260101-000000.log", 90);
    const fresh = givenOldLog("fresh-20260803-000000.log", 1);

    await relaunchWith({ autoLog: true, logDir: LOG_DIR, logRetentionDays: 30 });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test("索引に無いファイルは消さない", async () => {
    // 出力先にユーザーが置いた別のファイルを巻き込まないこと
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    givenOldLog("mine-20260101-000000.log", 90);

    // PaneDeck が作ったものと同じ形の名前だが、索引には無い
    const lookalike = path.join(LOG_DIR, "theirs-20200101-000000.log");
    fs.writeFileSync(lookalike, "user's own", "utf8");
    const unrelated = path.join(LOG_DIR, "notes.txt");
    fs.writeFileSync(unrelated, "important", "utf8");

    await relaunchWith({ autoLog: true, logDir: LOG_DIR, logRetentionDays: 30 });

    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test("保持期間 0 なら片付けない", async () => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    const ancient = givenOldLog("ancient-20200101-000000.log", 3650);

    await relaunchWith({
      autoLog: true,
      logDir: LOG_DIR,
      logRetentionDays: 0,
      logMaxTotalMB: 0,
    });

    expect(fs.existsSync(ancient)).toBe(true);
  });

  test("新しく作ったログは索引に載る", async () => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    await relaunchWith({ autoLog: true, logDir: LOG_DIR });

    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "indexed" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "output");

    // ★ 件数では見ない。索引には出来事の記録（events-*.jsonl）も載る。
    // 自動復元が前の試験のペイン（このマシンに無い作業フォルダ）を開けずに
    // 「restore-failed」を記録すると、それも載る（2026-10-10 まで、この失敗は
    // 黙って捨てられていたので件数がたまたま 1 だった）
    await expect
      .poll(() =>
        fs.existsSync(indexPath())
          ? JSON.parse(fs.readFileSync(indexPath(), "utf8")).filter((e: { file: string }) =>
              path.basename(e.file).startsWith("indexed-")
            ).length
          : 0
      )
      .toBe(1);
  });
});

test.describe("書き込みに失敗したとき", () => {
  test("アプリは落ちず、通知が出る", async () => {
    // 出力先と同じ名前のファイルを置いてディレクトリを作れなくする
    const blocked = path.join(TEMP_DIR, "blocked");
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(blocked, "not a directory", "utf8");

    await relaunchWith({ autoLog: true, logDir: blocked });

    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "doomed" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "this cannot be saved");

    await expect(page.locator("[data-testid=message]")).toContainText("ログ");

    // アプリは動き続ける
    await createSession(page, { cwd: "C:\\app\\repo-b", title: "still-alive" });
    await waitForPaneCount(page, 2);
  });
});

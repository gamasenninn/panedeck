import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

const TEMP_DIR = path.join(__dirname, "temp-auto-log");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const LOG_DIR = path.join(TEMP_DIR, "logs");

let electronApp;
let page;

/** 設定ファイルを直接書いてからアプリを起動する。 */
async function launchWith(settings) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), "utf8");

  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
}

async function relaunchWith(settings) {
  if (electronApp) await closeApp(electronApp);
  await launchWith(settings);
}

function logFiles(dir = LOG_DIR) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function readLog(name, dir = LOG_DIR) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

const autoLogToggle = () => page.locator("[data-testid=auto-log]");

test.beforeAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.afterAll(async () => {
  if (electronApp) await closeApp(electronApp);
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
    await expect
      .poll(() => readLog(logFiles()[0]))
      .toContain("building module 1");
    expect(readLog(logFiles()[0])).toContain("done");
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

    const named = (prefix) =>
      logFiles().find((n) => n.startsWith(`${prefix}-`));

    await expect.poll(() => Boolean(named("one") && named("two"))).toBe(true);
    await expect.poll(() => readLog(named("one"))).toContain("AAA");
    expect(readLog(named("one"))).not.toContain("BBB");
    expect(readLog(named("two"))).toContain("BBB");
  });

  test("ANSI エスケープは既定で落とす", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "colored" });
    await waitForPaneCount(page, 1);

    await emitPtyData(electronApp, 0, "\x1b[31mred\x1b[0m plain");

    const named = () => logFiles().find((n) => n.startsWith("colored-"));
    await expect.poll(() => (named() ? readLog(named()) : "")).toContain("red plain");
    expect(readLog(named())).not.toContain("\x1b[31m");
  });

  test("アプリを閉じてもファイルが残る", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", title: "survivor" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "written before quit");

    const named = () => logFiles().find((n) => n.startsWith("survivor-"));
    await expect.poll(() => Boolean(named())).toBe(true);
    const name = named();

    await closeApp(electronApp);
    electronApp = null;

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
    await autoLogToggle().check();

    await createSession(page, { cwd: "C:\\app\\repo-a", title: "late" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "after enabling");

    await expect.poll(() => logFiles().length).toBeGreaterThan(0);
    const name = logFiles().find((n) => n.startsWith("late-"));
    expect(readLog(name)).toContain("after enabling");
  });

  test("トグルの状態は保存される", async () => {
    await expect
      .poll(() => JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).autoLog)
      .toBe(true);
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

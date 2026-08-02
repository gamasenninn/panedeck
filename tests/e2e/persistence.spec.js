const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  writtenTo,
  listSessions,
  mockOpenDialog,
  mockOpenDialogCancel,
  mockSaveDialog,
  mockSaveDialogCancel,
  resetSessions,
  waitForPaneCount,
} = require("./helpers/electron-app");

const TEMP_DIR = path.join(__dirname, "temp");

let electronApp;
let page;

test.beforeAll(async () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe("出力ログの保存", () => {
  test("ペインのログボタンで出力をファイルに保存できる", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "hello from claude\nsecond line\n");

    const logPath = path.join(TEMP_DIR, "session.log");
    await mockSaveDialog(electronApp, logPath);
    await page.locator("[data-testid=pane-savelog]").click();

    await expect.poll(() => fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("hello from claude");
    expect(content).toContain("second line");
  });

  test("保存をキャンセルするとファイルは作られない", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);
    await emitPtyData(electronApp, 0, "not saved");

    const logPath = path.join(TEMP_DIR, "canceled.log");
    await mockSaveDialogCancel(electronApp);
    await page.locator("[data-testid=pane-savelog]").click();

    await expect(page.locator("[data-testid=pane-status]")).toBeVisible();
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test("出力の無いセッションでも空ログを保存できる", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-empty" });
    await waitForPaneCount(page, 1);

    const logPath = path.join(TEMP_DIR, "empty.log");
    await mockSaveDialog(electronApp, logPath);
    await page.locator("[data-testid=pane-savelog]").click();

    await expect.poll(() => fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toBe("");
  });
});

test.describe("ワークスペースの保存と復元", () => {
  const wsPath = () => path.join(TEMP_DIR, "workspace.json");

  test("構成を保存すると復元用の JSON が書き出される", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await createSession(page, { cwd: "C:\\app\\repo-b", title: "サブ" });
    await waitForPaneCount(page, 2);

    await mockSaveDialog(electronApp, wsPath());
    await page.locator("[data-testid=save-workspace]").click();

    await expect.poll(() => fs.existsSync(wsPath())).toBe(true);
    const saved = JSON.parse(fs.readFileSync(wsPath(), "utf8"));
    expect(saved.sessions).toHaveLength(2);
    expect(saved.sessions.map((s) => s.cwd)).toEqual([
      "C:\\app\\repo-a",
      "C:\\app\\repo-b",
    ]);
    expect(saved.sessions[1].title).toBe("サブ");
    // 実行時の情報は保存しない
    expect(saved.sessions[0].id).toBeUndefined();
    expect(saved.sessions[0].status).toBeUndefined();
  });

  test("保存した構成を復元するとペインが再生成される", async () => {
    await resetSessions(electronApp, page);
    await waitForPaneCount(page, 0);

    await mockOpenDialog(electronApp, [wsPath()]);
    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 2);

    await expect(page.locator("[data-testid=pane-title]")).toHaveText([
      "repo-a",
      "サブ",
    ]);

    const sessions = await listSessions(electronApp);
    expect(sessions.map((s) => s.cwd)).toEqual([
      "C:\\app\\repo-a",
      "C:\\app\\repo-b",
    ]);
  });

  test("復元時にツールバーの起動コマンドが各セッションへ流し込まれる", async () => {
    await resetSessions(electronApp, page);
    await mockOpenDialog(electronApp, [wsPath()]);
    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 2);

    expect(await writtenTo(electronApp, 0)).toEqual(["claude\r"]);
    expect(await writtenTo(electronApp, 1)).toEqual(["claude\r"]);
  });

  test("復元をキャンセルするとセッションは増えない", async () => {
    await resetSessions(electronApp, page);
    await mockOpenDialogCancel(electronApp);

    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 0);

    expect(await listSessions(electronApp)).toHaveLength(0);
  });

  test("壊れた構成ファイルはエラーとして表示する", async () => {
    await resetSessions(electronApp, page);
    const brokenPath = path.join(TEMP_DIR, "broken.json");
    fs.writeFileSync(brokenPath, "{ これは JSON ではない", "utf8");

    await mockOpenDialog(electronApp, [brokenPath]);
    await page.locator("[data-testid=restore-workspace]").click();

    await expect(page.locator("[data-testid=message]")).toContainText(
      "ワークスペース"
    );
    expect(await listSessions(electronApp)).toHaveLength(0);
  });

  test("保存をキャンセルするとファイルは作られない", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);

    const canceledPath = path.join(TEMP_DIR, "canceled-workspace.json");
    await mockSaveDialogCancel(electronApp);
    await page.locator("[data-testid=save-workspace]").click();

    await expect(page.locator("[data-testid=session-count]")).toHaveText(
      "1 セッション"
    );
    expect(fs.existsSync(canceledPath)).toBe(false);
  });
});

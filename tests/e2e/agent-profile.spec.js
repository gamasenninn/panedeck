const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  launchApp,
  closeApp,
  useFakePty,
  useFakeClock,
  advanceClock,
  createSession,
  emitPtyData,
  writtenTo,
  listSessions,
  mockOpenDialog,
  mockSaveDialog,
  resetSessions,
  waitForPaneCount,
} = require("./helpers/electron-app");

const TEMP_DIR = path.join(__dirname, "temp-agent");

let electronApp;
let page;

test.beforeAll(async () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
  await useFakeClock(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

const agentSelect = () => page.locator("[data-testid=agent-select]");
const launchCommand = () => page.locator("[data-testid=launch-command]");
const statusBadge = (i) => page.locator("[data-testid=pane-status]").nth(i);

/** ツールバーを既定（Claude Code）に戻す */
async function resetToolbar() {
  await agentSelect().selectOption("claude");
}

test("同梱プロファイルが選択肢に並ぶ", async () => {
  await resetSessions(electronApp, page);
  const ids = await agentSelect().locator("option").evaluateAll((options) =>
    options.map((o) => o.value)
  );

  expect(ids).toContain("claude");
  expect(ids).toContain("codex");
  expect(ids).toContain("gemini");
  expect(ids).toContain("shell");
});

test("既定は Claude Code（現行動作の維持）", async () => {
  await resetSessions(electronApp, page);
  await resetToolbar();

  await expect(agentSelect()).toHaveValue("claude");
  await expect(launchCommand()).toHaveValue("claude");
});

test("エージェントを選ぶと起動コマンドが入れ替わる", async () => {
  await resetSessions(electronApp, page);
  await agentSelect().selectOption("codex");
  await expect(launchCommand()).toHaveValue("codex");

  await agentSelect().selectOption("gemini");
  await expect(launchCommand()).toHaveValue("gemini");

  // シェルは素のまま起動したいので既定コマンドを持たない
  await agentSelect().selectOption("shell");
  await expect(launchCommand()).toHaveValue("");

  await resetToolbar();
});

test("選んだエージェントでセッションが起動する", async () => {
  await resetSessions(electronApp, page);
  await agentSelect().selectOption("codex");

  await mockOpenDialog(electronApp, ["C:\\app\\repo-codex"]);
  await page.locator("[data-testid=add-session]").click();
  await waitForPaneCount(page, 1);

  const sessions = await listSessions(electronApp);
  expect(sessions[0].agent).toBe("codex");
  expect(await writtenTo(electronApp, 0)).toEqual(["codex\r"]);

  await resetToolbar();
});

test("エージェントごとに入力待ちの判定が変わる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", agent: "claude" });
  await createSession(page, { cwd: "C:\\app\\repo-b", agent: "codex" });
  await waitForPaneCount(page, 2);

  await advanceClock(electronApp, 1000);
  // Claude Code の入力ボックス。claude のプロファイルでだけ入力待ちになる
  await emitPtyData(electronApp, 0, "╭────────╮\n│ >      │\n╰────────╯");
  await emitPtyData(electronApp, 1, "╭────────╮\n│ >      │\n╰────────╯");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge(0)).toHaveText("入力待ち");
  await expect(statusBadge(1)).toHaveText("待機");
});

test("共通の確認プロンプトはどのエージェントでも入力待ちになる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", agent: "claude" });
  await createSession(page, { cwd: "C:\\app\\repo-b", agent: "codex" });
  await waitForPaneCount(page, 2);

  await advanceClock(electronApp, 1000);
  await emitPtyData(electronApp, 0, "Overwrite? (y/n)");
  await emitPtyData(electronApp, 1, "Overwrite? (y/n)");
  await advanceClock(electronApp, 1000);

  await expect(statusBadge(0)).toHaveText("入力待ち");
  await expect(statusBadge(1)).toHaveText("入力待ち");
});

test.describe("ワークスペースとの往復", () => {
  const wsPath = () => path.join(TEMP_DIR, "agents.json");

  test("エージェントが構成に保存される", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, {
      cwd: "C:\\app\\repo-a",
      agent: "claude",
      initialCommand: "claude",
    });
    await createSession(page, {
      cwd: "C:\\app\\repo-b",
      agent: "codex",
      initialCommand: "codex",
    });
    await waitForPaneCount(page, 2);

    await mockSaveDialog(electronApp, wsPath());
    await page.locator("[data-testid=save-workspace]").click();

    await expect.poll(() => fs.existsSync(wsPath())).toBe(true);
    const saved = JSON.parse(fs.readFileSync(wsPath(), "utf8"));
    expect(saved.sessions.map((s) => s.agent)).toEqual(["claude", "codex"]);
  });

  test("復元するとエージェントごとの判定も戻る", async () => {
    await resetSessions(electronApp, page);
    await mockOpenDialog(electronApp, [wsPath()]);
    await page.locator("[data-testid=restore-workspace]").click();
    await waitForPaneCount(page, 2);

    expect((await listSessions(electronApp)).map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);

    await advanceClock(electronApp, 1000);
    await emitPtyData(electronApp, 0, "│ > ");
    await emitPtyData(electronApp, 1, "│ > ");
    await advanceClock(electronApp, 1000);

    await expect(statusBadge(0)).toHaveText("入力待ち");
    await expect(statusBadge(1)).toHaveText("待機");
  });
});

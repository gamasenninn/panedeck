const { test, expect } = require("@playwright/test");
const {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  writtenTo,
  listSessions,
  mockOpenDialog,
  mockOpenDialogCancel,
  resetSessions,
  waitForPaneCount,
} = require("./helpers/electron-app");

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

test("初期状態ではセッションが無く、空状態が表示される", async () => {
  await resetSessions(electronApp, page);
  await waitForPaneCount(page, 0);

  await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
  await expect(page.locator("[data-testid=session-count]")).toHaveText(
    "0 セッション"
  );
});

test("セッションを作るとペインが現れる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText("repo-a");
  await expect(page.locator("[data-testid=pane-cwd]")).toHaveText("C:\\app\\repo-a");
  await expect(page.locator("[data-testid=empty-state]")).toBeHidden();
});

test("複数セッションがグリッドに並ぶ", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await createSession(page, { cwd: "C:\\app\\repo-b" });
  await createSession(page, { cwd: "C:\\app\\repo-c" });
  await waitForPaneCount(page, 3);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText([
    "repo-a",
    "repo-b",
    "repo-c",
  ]);
  await expect(page.locator("[data-testid=session-count]")).toHaveText(
    "3 セッション"
  );

  // メインプロセス側にも 3 セッション存在する
  expect(await listSessions(electronApp)).toHaveLength(3);
});

test("title を指定すればそれが使われる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", title: "本番デプロイ" });
  await waitForPaneCount(page, 1);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText("本番デプロイ");
});

test("initialCommand がセッション起動直後に流し込まれる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", initialCommand: "claude" });
  await waitForPaneCount(page, 1);

  expect(await writtenTo(electronApp, 0)).toEqual(["claude\r"]);
});

test("initialCommand が空なら何も書き込まない", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", initialCommand: "" });
  await waitForPaneCount(page, 1);

  expect(await writtenTo(electronApp, 0)).toEqual([]);
});

test("ペインの × でそのセッションだけ閉じる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await createSession(page, { cwd: "C:\\app\\repo-b" });
  await waitForPaneCount(page, 2);

  await page.locator("[data-testid=pane-close]").first().click();
  await waitForPaneCount(page, 1);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText("repo-b");

  const sessions = await listSessions(electronApp);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].title).toBe("repo-b");
});

test("全終了ですべてのセッションが閉じる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await createSession(page, { cwd: "C:\\app\\repo-b" });
  await waitForPaneCount(page, 2);

  await page.locator("[data-testid=close-all]").click();
  await waitForPaneCount(page, 0);

  expect(await listSessions(electronApp)).toHaveLength(0);
  await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
});

test("セッション追加ボタンでディレクトリを選ぶとセッションが起動する", async () => {
  await resetSessions(electronApp, page);
  await mockOpenDialog(electronApp, ["C:\\app\\picked-repo"]);

  await page.locator("[data-testid=add-session]").click();
  await waitForPaneCount(page, 1);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText("picked-repo");
  // ツールバーの起動コマンド（既定 "claude"）が流し込まれる
  expect(await writtenTo(electronApp, 0)).toEqual(["claude\r"]);
});

test("ディレクトリ選択をキャンセルしたらセッションは増えない", async () => {
  await resetSessions(electronApp, page);
  await mockOpenDialogCancel(electronApp);

  await page.locator("[data-testid=add-session]").click();
  await waitForPaneCount(page, 0);

  expect(await listSessions(electronApp)).toHaveLength(0);
});

test.describe("セッションごとの起動コマンド", () => {
  test("セッションごとに異なるコマンドで起動できる", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", initialCommand: "claude" });
    await createSession(page, { cwd: "C:\\app\\repo-b", initialCommand: "codex --resume" });
    await createSession(page, { cwd: "C:\\app\\repo-c", initialCommand: "" });
    await waitForPaneCount(page, 3);

    expect(await writtenTo(electronApp, 0)).toEqual(["claude\r"]);
    expect(await writtenTo(electronApp, 1)).toEqual(["codex --resume\r"]);
    expect(await writtenTo(electronApp, 2)).toEqual([]);
  });

  test("ツールバーの値を変えれば追加ごとに違うコマンドを使える", async () => {
    await resetSessions(electronApp, page);
    const toolbar = page.locator("[data-testid=launch-command]");

    await mockOpenDialog(electronApp, ["C:\\app\\repo-claude"]);
    await toolbar.fill("claude");
    await page.locator("[data-testid=add-session]").click();
    await waitForPaneCount(page, 1);

    await mockOpenDialog(electronApp, ["C:\\app\\repo-codex"]);
    await toolbar.fill("codex");
    await page.locator("[data-testid=add-session]").click();
    await waitForPaneCount(page, 2);

    expect(await writtenTo(electronApp, 0)).toEqual(["claude\r"]);
    expect(await writtenTo(electronApp, 1)).toEqual(["codex\r"]);

    // 後続のテストのために既定値へ戻す
    await toolbar.fill("claude");
  });

  test("ペインヘッダに起動コマンドが出る", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", initialCommand: "codex --resume" });
    await waitForPaneCount(page, 1);

    await expect(page.locator("[data-testid=pane-command]")).toHaveText(
      "codex --resume"
    );
  });

  test("起動コマンドが無いペインのヘッダは空", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a" });
    await waitForPaneCount(page, 1);

    await expect(page.locator("[data-testid=pane-command]")).toHaveText("");
  });

  test("セッション一覧にも起動コマンドが載る", async () => {
    await resetSessions(electronApp, page);
    await createSession(page, { cwd: "C:\\app\\repo-a", initialCommand: "  gemini  " });
    await waitForPaneCount(page, 1);

    const sessions = await listSessions(electronApp);
    expect(sessions[0].initialCommand).toBe("gemini");
  });
});

import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  writtenTo,
  launchedIn,
  listSessions,
  mockOpenDialog,
  mockOpenDialogCancel,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

let electronApp: ElectronApplication;
let page: Page;

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

  // 既定のプロファイルは会話の id を添えて起こす（#33）。id は毎回違うので伏せる
  expect(await launchedIn(electronApp, 0)).toEqual(["claude --session-id <uuid>\r"]);
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
  // 押しただけでは閉じない。何が止まるかを数で出して、もう一度押させる
  await expect(page.locator("[data-testid=close-all-confirm]")).toContainText(
    "2 個のセッションを終了します"
  );
  expect(await listSessions(electronApp)).toHaveLength(2);

  await page.locator("[data-testid=close-all-ok]").click();
  await waitForPaneCount(page, 0);

  expect(await listSessions(electronApp)).toHaveLength(0);
  await expect(page.locator("[data-testid=empty-state]")).toBeVisible();
  await expect(page.locator("[data-testid=close-all-confirm]")).toBeHidden();
});

/**
 * **押し間違いを取り消せる**（2026-10-09）。以前は確認なしで全ペインを終了し、
 * 作業中の claude も途中で止まっていた。
 */
test("全終了の確認で「やめる」を押すと、何も閉じない", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);

  await page.locator("[data-testid=close-all]").click();
  await page.locator("[data-testid=close-all-cancel]").click();

  await expect(page.locator("[data-testid=close-all-confirm]")).toBeHidden();
  expect(await listSessions(electronApp)).toHaveLength(1);
});

/**
 * **全終了を押し通した後でも取り返せる**（2026-10-09）。
 *
 * 確認は慣れると反射で押される。全終了の直前の構成を 1 つだけ控え、空の画面に
 * 「直前の構成に戻す」を出す。戻すと自動復元と同じ経路を通る（会話の再開も）。
 * **自動では戻さない** —— 全部閉じたら次の起動は空のまま、は変えない。
 */
test("全終了の後、直前の構成に戻せる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a", title: "本体" });
  await createSession(page, { cwd: "C:\\app\\repo-b", title: "受付" });
  await waitForPaneCount(page, 2);

  await page.locator("[data-testid=close-all]").click();
  await page.locator("[data-testid=close-all-ok]").click();
  await waitForPaneCount(page, 0);

  const back = page.locator("[data-testid=restore-previous]");
  await expect(back).toBeVisible();
  await expect(back).toContainText("2");

  await back.click();
  await waitForPaneCount(page, 2);
  expect((await listSessions(electronApp)).map((x) => x.title)).toEqual(["本体", "受付"]);
  // 一度戻したら消える。二度押すと同じペインが二重にできる
  await expect(back).toBeHidden();
});

test("全終了していなければ、直前の構成に戻すは出ない", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);
  await page.locator("[data-testid=pane-close]").first().click();
  await waitForPaneCount(page, 0);

  await expect(page.locator("[data-testid=restore-previous]")).toBeHidden();
});

/**
 * **確認はポップアップで出す**（2026-10-09、小野さんの依頼）。ツールバーの中に
 * 出していたときは、目に入りにくかった。画面全体を覆い、他を押せなくする。
 * `window.confirm` は E2E を止めるので使わない。
 *
 * ★ **最初に選ばれているのは「やめる」。** Enter の押し間違いで終了しない
 */
test("全終了の確認はポップアップで出て、最初は「やめる」が選ばれている", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);

  await page.locator("[data-testid=close-all]").click();

  const popup = page.locator("[data-testid=close-all-confirm]");
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("role", "dialog");
  await expect(page.locator("[data-testid=close-all-backdrop]")).toBeVisible();
  await expect(page.locator("[data-testid=close-all-cancel]")).toBeFocused();

  // 選ばれたまま Enter を押しても、閉じるのは確認だけ
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  expect(await listSessions(electronApp)).toHaveLength(1);
});

test("全終了の確認は Esc で閉じ、何も閉じない", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "C:\\app\\repo-a" });
  await waitForPaneCount(page, 1);

  await page.locator("[data-testid=close-all]").click();
  await expect(page.locator("[data-testid=close-all-confirm]")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator("[data-testid=close-all-confirm]")).toBeHidden();
  expect(await listSessions(electronApp)).toHaveLength(1);
});

test("ペインが無いときに全終了を押しても、確認は出さない", async () => {
  await resetSessions(electronApp, page);

  await page.locator("[data-testid=close-all]").click();

  await expect(page.locator("[data-testid=close-all-confirm]")).toBeHidden();
});

test("セッション追加ボタンでディレクトリを選ぶとセッションが起動する", async () => {
  await resetSessions(electronApp, page);
  await mockOpenDialog(electronApp, ["C:\\app\\picked-repo"]);

  await page.locator("[data-testid=add-session]").click();
  await waitForPaneCount(page, 1);

  await expect(page.locator("[data-testid=pane-title]")).toHaveText("picked-repo");
  // ツールバーの起動コマンド（既定 "claude"）が流し込まれる
  expect(await launchedIn(electronApp, 0)).toEqual(["claude --session-id <uuid>\r"]);
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

    expect(await launchedIn(electronApp, 0)).toEqual(["claude --session-id <uuid>\r"]);
    // **人が自分で `--resume` と書いた指定には足さない**（#33）
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

    expect(await launchedIn(electronApp, 0)).toEqual(["claude --session-id <uuid>\r"]);
    expect(await launchedIn(electronApp, 1)).toEqual(["codex --session-id <uuid>\r"]);

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

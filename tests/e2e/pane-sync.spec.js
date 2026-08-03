const { test, expect } = require("@playwright/test");
const {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  listSessions,
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

/**
 * log:get を「テストが解放するまで返さない」ゲートに差し替える。
 *
 * レンダラはペインを panes へ登録する前に log:get を待つため、その待ち時間が
 * 同期ポーリング間隔（300ms）を超えると同じセッションのペインが二重に作られる。
 * 実時間の遅延に頼ると再現がブレるので、応答を保留して race を確定的に起こす。
 *
 * 呼ばれたセッション id は `__logCalls` に積み続ける（解放後もリセットしない）。
 * これが createPane の呼び出し履歴になり、重複＝ペインの二重生成を意味する。
 * `__listCount` は同期が何周したかの目印で、待ち時間ではなく回数で待てる。
 */
async function gateGetLog(app) {
  await app.evaluate(({ ipcMain }) => {
    global.__logCalls = [];
    global.__logGate = [];
    global.__listCount = 0;

    ipcMain.removeHandler("log:get");
    ipcMain.handle("log:get", (_, id) => {
      global.__logCalls.push(id);
      return new Promise((resolve) => {
        global.__logGate.push(() => resolve(global.__sessionManager.getLog(id)));
      });
    });

    ipcMain.removeHandler("session:list");
    ipcMain.handle("session:list", () => {
      global.__listCount += 1;
      return global.__sessionManager.list();
    });
  });
}

/** 保留していた log:get を解放する。以降は待たずに返すが履歴は取り続ける。 */
async function releaseGetLog(app) {
  await app.evaluate(({ ipcMain }) => {
    global.__logGate.forEach((release) => release());
    global.__logGate = [];
    ipcMain.removeHandler("log:get");
    ipcMain.handle("log:get", (_, id) => {
      global.__logCalls.push(id);
      return global.__sessionManager.getLog(id);
    });
  });
}

/** createPane が走ったセッション id の履歴。 */
function logCalls(app) {
  return app.evaluate(() => global.__logCalls);
}

function listCalls(app) {
  return app.evaluate(() => global.__listCount);
}

/** 同期が指定回数まわるまで待つ。 */
async function waitForSyncPasses(app, passes) {
  const base = await listCalls(app);
  await expect.poll(() => listCalls(app)).toBeGreaterThanOrEqual(base + passes);
}

test("ログ取得の完了前に同期が再入してもペインは二重に作られない", async () => {
  await resetSessions(electronApp, page);
  await gateGetLog(electronApp);

  await createSession(page, { cwd: "C:\\app\\repo-a" });

  // log:get を保留したまま同期を 3 周させる
  await waitForSyncPasses(electronApp, 3);

  // 3 周しても同じセッションの createPane は 1 回きりであるべき
  expect(await logCalls(electronApp)).toHaveLength(1);

  await releaseGetLog(electronApp);
  await waitForPaneCount(page, 1);
  expect(await listSessions(electronApp)).toHaveLength(1);
});

test("複数セッションを同時に作ってもセッションごとにペインは 1 つだけ", async () => {
  await resetSessions(electronApp, page);
  await gateGetLog(electronApp);

  await Promise.all([
    createSession(page, { cwd: "C:\\app\\repo-a" }),
    createSession(page, { cwd: "C:\\app\\repo-b" }),
    createSession(page, { cwd: "C:\\app\\repo-c" }),
    createSession(page, { cwd: "C:\\app\\repo-d" }),
  ]);

  await waitForSyncPasses(electronApp, 3);
  await releaseGetLog(electronApp);
  await waitForPaneCount(page, 4);

  // どのセッションも createPane は 1 回きり（重複＝幽霊ペイン）
  const calls = await logCalls(electronApp);
  expect(calls).toHaveLength(new Set(calls).size);
  expect(calls).toHaveLength(4);

  await expect(page.locator("[data-testid=session-count]")).toHaveText(
    "4 セッション"
  );
  expect(await listSessions(electronApp)).toHaveLength(4);
});

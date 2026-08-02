const { test, expect } = require("@playwright/test");
const path = require("path");
const {
  launchApp,
  closeApp,
  createSession,
  waitForPaneCount,
} = require("./helpers/electron-app");

/**
 * このスイートだけはフェイクを使わず、実際に node-pty でプロセスを起動する。
 * 短命なコマンドを走らせて、pty 連携が本当に動くことを確認する。
 */

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MARKER = "CLAUDEDECK_OK";

const REAL_SHELL =
  process.platform === "win32"
    ? { shell: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", `Write-Output ${MARKER}`] }
    : { shell: "bash", args: ["-c", `echo ${MARKER}`] };

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

async function logOf(id) {
  return electronApp.evaluate(
    (_, sessionId) => global.__sessionManager.getLog(sessionId),
    id
  );
}

async function statusOf(id) {
  return electronApp.evaluate(
    (_, sessionId) => global.__sessionManager.get(sessionId)?.status,
    id
  );
}

test("実プロセスを起動して出力を受け取り、終了を検知する", async () => {
  const result = await createSession(page, {
    cwd: PROJECT_ROOT,
    ...REAL_SHELL,
  });

  expect(result.ok).toBe(true);
  const { id } = result.session;

  await waitForPaneCount(page, 1);

  // pty の出力がメインプロセスのログに蓄積される
  await expect.poll(() => logOf(id), { timeout: 20000 }).toContain(MARKER);

  // コマンドが終わればプロセス終了として扱われる
  await expect.poll(() => statusOf(id), { timeout: 20000 }).toBe("exited");
});

test("存在しない cwd を指定したらエラーを返す（アプリは落ちない）", async () => {
  const result = await createSession(page, {
    cwd: path.join(PROJECT_ROOT, "no-such-directory-12345"),
    ...REAL_SHELL,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();

  // アプリは生きていて操作を受け付ける
  await expect(page.locator("[data-testid=add-session]")).toBeEnabled();
});

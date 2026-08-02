const { _electron: electron } = require("@playwright/test");
const path = require("path");

const APP_PATH = path.resolve(__dirname, "..", "..", "..");

/**
 * Electron アプリを起動し、アプリと最初のウィンドウを返す。
 */
async function launchApp() {
  const electronApp = await electron.launch({ args: [APP_PATH] });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}

/**
 * アプリを終了する。
 */
async function closeApp(electronApp) {
  await electronApp.close();
}

/**
 * SessionManager の ptyFactory をフェイクに差し替える。
 *
 * 実プロセスを起動しないので、E2E でも write / kill / 出力の発火を
 * 決定的に検証できる。生成された pty は `global.__fakePtys` に積まれる。
 */
async function useFakePty(electronApp) {
  await electronApp.evaluate(() => {
    global.__fakePtys = [];
    global.__sessionManager.ptyFactory = (options) => {
      const dataHandlers = [];
      const exitHandlers = [];
      const fake = {
        options,
        written: [],
        killed: false,
        write: (data) => fake.written.push(data),
        resize: () => {},
        kill: () => {
          fake.killed = true;
        },
        onData: (cb) => dataHandlers.push(cb),
        onExit: (cb) => exitHandlers.push(cb),
        emitData: (data) => dataHandlers.forEach((cb) => cb(data)),
        emitExit: (exitCode) =>
          exitHandlers.forEach((cb) => cb({ exitCode })),
      };
      global.__fakePtys.push(fake);
      return fake;
    };
  });
}

/**
 * レンダラ経由でセッションを作る（ディレクトリ選択ダイアログを通さない）。
 */
async function createSession(page, options) {
  return page.evaluate((opts) => window.deck.createSession(opts), options);
}

/**
 * フェイク pty から出力を発火させる。
 */
async function emitPtyData(electronApp, index, data) {
  await electronApp.evaluate(
    (_, { index: i, data: d }) => global.__fakePtys.at(i).emitData(d),
    { index, data }
  );
}

/**
 * フェイク pty のプロセス終了を発火させる。
 */
async function emitPtyExit(electronApp, index, exitCode = 0) {
  await electronApp.evaluate(
    (_, { index: i, exitCode: c }) => global.__fakePtys.at(i).emitExit(c),
    { index, exitCode }
  );
}

/**
 * フェイク pty に書き込まれた内容を取り出す。
 */
async function writtenTo(electronApp, index) {
  return electronApp.evaluate((_, i) => global.__fakePtys.at(i).written, index);
}

/**
 * 現在のセッション一覧をメインプロセスから直接取得する。
 */
async function listSessions(electronApp) {
  return electronApp.evaluate(() => global.__sessionManager.list());
}

/**
 * dialog.showOpenDialog をディレクトリ選択のモックに差し替える。
 */
async function mockOpenDialog(electronApp, filePaths) {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, filePaths);
}

/**
 * dialog.showOpenDialog をキャンセルのモックに差し替える。
 */
async function mockOpenDialogCancel(electronApp) {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
}

/**
 * dialog.showSaveDialog を保存先固定のモックに差し替える。
 */
async function mockSaveDialog(electronApp, filePath) {
  await electronApp.evaluate(({ dialog }, fp) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
  }, filePath);
}

/**
 * dialog.showSaveDialog をキャンセルのモックに差し替える。
 */
async function mockSaveDialogCancel(electronApp) {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
}

/**
 * 全セッションを閉じ、フェイク pty の記録も消してテスト間の状態をリセットする。
 * リセット後は `global.__fakePtys` の添字が 0 から始まる。
 *
 * page を渡すと、画面上のペインが実際に消えるまで待つ。レンダラはセッション一覧を
 * ポーリングして追従するため、これを待たないと「前のテストの残骸ペイン」で
 * waitForPaneCount が即座に成立し、消える直前のペインを操作してしまう。
 */
async function resetSessions(electronApp, page) {
  await electronApp.evaluate(() => {
    global.__sessionManager.closeAll();
    global.__fakePtys = [];
  });
  if (page) await waitForPaneCount(page, 0);
}

/**
 * SessionManager の時計をテストから操作できる固定クロックに差し替える。
 *
 * 状態判定は「最後の出力からの経過時間」で決まるため、実時間に頼ると
 * running / idle の切り替わりがテストごとにブレる。クロックを固定すれば
 * 状態遷移を決定的に検証できる。
 */
async function useFakeClock(electronApp, start = 1000) {
  await electronApp.evaluate((_, t) => {
    global.__clock = t;
    global.__sessionManager.now = () => global.__clock;
  }, start);
}

/**
 * 固定クロックを進める。
 */
async function advanceClock(electronApp, ms) {
  await electronApp.evaluate((_, delta) => {
    global.__clock += delta;
  }, ms);
}

/**
 * ペインが指定数になるまで待つ。
 */
async function waitForPaneCount(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".pane").length === expected,
    count
  );
}

module.exports = {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  emitPtyExit,
  writtenTo,
  listSessions,
  mockOpenDialog,
  mockOpenDialogCancel,
  mockSaveDialog,
  mockSaveDialogCancel,
  resetSessions,
  useFakeClock,
  advanceClock,
  waitForPaneCount,
};

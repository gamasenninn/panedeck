import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import path from "path";

const APP_PATH = path.resolve(__dirname, "..", "..", "..");

/**
 * Electron アプリを起動し、アプリと最初のウィンドウを返す。
 *
 * `settingsPath` を渡すと設定ファイルの場所を差し替える。レンダラは起動直後に
 * 設定を読むので、起動後に注入する方式では初回の読み込みに間に合わない。
 * 環境変数なら main が最初に見るところに割り込めるうえ、アプリを再起動する
 * テストでも同じ場所を指し続けられる。
 */
export async function launchApp({ settingsPath }: { settingsPath?: string } = {}): Promise<{
  electronApp: ElectronApplication;
  page: Page;
}> {
  const electronApp = await electron.launch({
    args: [APP_PATH],
    env: (settingsPath
      ? { ...process.env, PANEDECK_SETTINGS_PATH: settingsPath }
      : process.env) as Record<string, string>,
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}

/**
 * アプリを終了する。
 */
export async function closeApp(electronApp: ElectronApplication) {
  await electronApp.close();
}

/**
 * SessionManager の ptyFactory をフェイクに差し替える。
 *
 * 実プロセスを起動しないので、E2E でも write / kill / 出力の発火を
 * 決定的に検証できる。生成された pty は `global.__fakePtys` に積まれる。
 */
export async function useFakePty(electronApp: ElectronApplication) {
  await electronApp.evaluate(() => {
    global.__fakePtys = [];
    global.__sessionManager.ptyFactory = (options: unknown) => {
      const dataHandlers: Array<(data: string) => void> = [];
      const exitHandlers: Array<(event: { exitCode: number }) => void> = [];
      const fake = {
        options,
        written: [] as string[],
        killed: false,
        write: (data: string) => fake.written.push(data),
        resize: () => {},
        kill: () => {
          fake.killed = true;
        },
        onData: (cb: (data: string) => void) => dataHandlers.push(cb),
        onExit: (cb: (event: { exitCode: number }) => void) => exitHandlers.push(cb),
        emitData: (data: string) => dataHandlers.forEach((cb) => cb(data)),
        emitExit: (exitCode: number) =>
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
export async function createSession(page: Page, options: Record<string, unknown>) {
  return page.evaluate((opts) => window.deck.createSession(opts), options);
}

/**
 * フェイク pty から出力を発火させる。
 */
export async function emitPtyData(electronApp: ElectronApplication, index: number, data: string) {
  await electronApp.evaluate(
    (_, { index: i, data: d }) => global.__fakePtys.at(i).emitData(d),
    { index, data }
  );
}

/**
 * フェイク pty のプロセス終了を発火させる。
 */
export async function emitPtyExit(electronApp: ElectronApplication, index: number, exitCode = 0) {
  await electronApp.evaluate(
    (_, { index: i, exitCode: c }) => global.__fakePtys.at(i).emitExit(c),
    { index, exitCode }
  );
}

/**
 * フェイク pty に書き込まれた内容を取り出す。
 */
export async function writtenTo(electronApp: ElectronApplication, index: number): Promise<string[]> {
  return electronApp.evaluate((_, i) => global.__fakePtys.at(i).written, index);
}

/**
 * 現在のセッション一覧をメインプロセスから直接取得する。
 */
export async function listSessions(electronApp: ElectronApplication): Promise<any[]> {
  return electronApp.evaluate(() => global.__sessionManager.list());
}

/**
 * dialog.showOpenDialog をディレクトリ選択のモックに差し替える。
 */
export async function mockOpenDialog(electronApp: ElectronApplication, filePaths: string[]) {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, filePaths);
}

/**
 * dialog.showOpenDialog をキャンセルのモックに差し替える。
 */
export async function mockOpenDialogCancel(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
}

/**
 * dialog.showSaveDialog を保存先固定のモックに差し替える。
 */
export async function mockSaveDialog(electronApp: ElectronApplication, filePath: string) {
  await electronApp.evaluate(({ dialog }, fp) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
  }, filePath);
}

/**
 * dialog.showSaveDialog をキャンセルのモックに差し替える。
 */
export async function mockSaveDialogCancel(electronApp: ElectronApplication) {
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
export async function resetSessions(electronApp: ElectronApplication, page?: Page) {
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
export async function useFakeClock(electronApp: ElectronApplication, start = 1000) {
  await electronApp.evaluate((_, t) => {
    global.__clock = t;
    global.__sessionManager.now = () => global.__clock;
  }, start);
}

/**
 * 固定クロックを進める。
 */
export async function advanceClock(electronApp: ElectronApplication, ms: number) {
  await electronApp.evaluate((_, delta) => {
    global.__clock += delta;
  }, ms);
}

/**
 * ペインが指定数になるまで待つ。
 */
export async function waitForPaneCount(page: Page, count: number) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".pane").length === expected,
    count
  );
}

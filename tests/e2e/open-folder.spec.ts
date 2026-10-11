import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { launchApp, closeApp, createSession, waitForPaneCount } from "./helpers/electron-app";
import { saveWorkspace } from "../../lib/workspace";
import { folderStateDir } from "../../lib/open-folder";
import type { Session } from "../../types/panedeck";

/**
 * フォルダを開いて起動する（2026-10-11）。VS Code の `code <フォルダ>` と同じ考えで、
 * 新しいペインも裏のコマンド（#29）も、開いたフォルダで動く。
 *
 * 裏のコマンドは実プロセスを起こす（相対パスがどこで解決されるかを見るため）。
 */
test.describe.configure({ timeout: 60_000 });

const TEMP_DIR = path.join(__dirname, "temp-open-folder");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
/** 開くフォルダ。設定とは別の場所にする（同じだと、どちらで解決されたか分からない） */
const FOLDER = path.join(TEMP_DIR, "work");
/** 開いていないフォルダ（そこ向けのサービスは動かない） */
const OTHER_FOLDER = path.join(TEMP_DIR, "other");
/** 裏のコマンドが**相対パスで**書くファイル。開いたフォルダに出来れば、そこで動いた */
const MARK = "service-ran.txt";

let electronApp: ElectronApplication;
let page: Page;

async function launchWith(args: string[], services: unknown[] = []) {
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ autoLog: false, autoRestore: false, services }),
    "utf8"
  );
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH, args }));
}

/** 相対パスでファイルを書いて終わるコマンド（スクリプトは絶対パスに置く） */
function writeMarkCommand(): string {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const script = path.join(TEMP_DIR, "write-mark.js");
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(MARK)}, 'x');`, "utf8");
  return `node ${JSON.stringify(script)}`;
}

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe("フォルダを開いて起動する", () => {
  test("ウィンドウの題に、開いたフォルダが出る", async () => {
    await launchWith([FOLDER]);
    await expect(page).toHaveTitle(`${FOLDER} — PaneDeck`);
  });

  /** 場所を選ぶダイアログを出さない。出ればここで止まり、ペインは増えない */
  test("「+ セッション追加」は、場所を聞かずに開いたフォルダでペインを作る", async () => {
    await launchWith([FOLDER]);
    await page.getByTestId("add-session").click();

    await expect(page.getByTestId("pane-cwd")).toHaveText(FOLDER);
    const cwds = await electronApp.evaluate(() =>
      global.__sessionManager.list().map((s: Session) => s.cwd)
    );
    expect(cwds).toEqual([FOLDER]);
  });

  test("別の場所を選ぶボタンが出る", async () => {
    await launchWith([FOLDER]);
    await expect(page.getByTestId("add-session-elsewhere")).toBeVisible();
  });

  test("裏のコマンドは、開いたフォルダで動く（相対パスがそこで解決される）", async () => {
    await launchWith(
      [FOLDER],
      [{ name: "mark", command: writeMarkCommand(), restart: "never", folder: FOLDER }]
    );
    await expect.poll(() => fs.existsSync(path.join(FOLDER, MARK))).toBe(true);
  });
});

test.describe("フォルダを開かずに起動する（今までどおり）", () => {
  test("題は PaneDeck のまま、別の場所を選ぶボタンは出ない", async () => {
    await launchWith([]);
    await expect(page).toHaveTitle("PaneDeck");
    await expect(page.getByTestId("add-session-elsewhere")).toBeHidden();
  });
});

/** 黙って今までどおりに起動すると、別の場所でサービスが動いたことに気づけない */
test.describe("無いフォルダを渡されたとき", () => {
  test("開けなかったことを知らせる", async () => {
    const nowhere = path.join(TEMP_DIR, "nowhere");
    await launchWith([nowhere]);
    await expect(page.getByTestId("message")).toContainText(nowhere);
    await expect(page.getByTestId("message")).toContainText("開けません");
    await expect(page).toHaveTitle("PaneDeck");
  });
});

/**
 * 構成はフォルダごと（2026-10-11）。フォルダを開いても共通の控えを戻していたので、
 * `C:\system` を開いたら本体・受付のペインが出て、同じ会話を二重に再開した
 */
test.describe("構成はフォルダごと", () => {
  /** 自動復元は起動時に実プロセスを立てる。OS によらず生き続ける node にする */
  const NODE = process.execPath;
  const STAY_ALIVE = ["-e", "setInterval(() => {}, 1000)"];
  const SHARED = path.join(TEMP_DIR, "last-session.json");
  const folderSaved = () =>
    path.join(
      folderStateDir(TEMP_DIR, FOLDER, { caseInsensitive: process.platform === "win32" }),
      "last-session.json"
    );

  async function launchRestoring(args: string[]) {
    fs.mkdirSync(FOLDER, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ autoLog: false, autoRestore: true }), "utf8");
    ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH, args }));
  }

  /** 閉じる前に畳む（生き続けるプロセスを抱えたまま閉じると、次の起動が詰まる。auto-restore と同じ） */
  async function closeQuietly() {
    await electronApp.evaluate(async () => {
      global.__sessionManager.closeAll();
      await global.__sessionManager.drained();
    });
    await closeApp(electronApp);
  }

  /** 共通の控えに「本体」のペインがある */
  function givenSharedSaved() {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    saveWorkspace(SHARED, [{ cwd: TEMP_DIR, shell: NODE, args: STAY_ALIVE, title: "本体" }], {
      name: "last-session",
    });
  }

  const titles = () =>
    electronApp.evaluate(() => global.__sessionManager.list().map((s: Session) => s.title));

  /** 下の試験が空振りでないことの確かめ（控えの作り方が合っていれば戻る） */
  test("フォルダを開かなければ、共通の控えを戻す（今までどおり）", async () => {
    givenSharedSaved();
    await launchRestoring([]);
    await waitForPaneCount(page, 1);
    expect(await titles()).toEqual(["本体"]);
    await closeQuietly();
  });

  test("フォルダを開くと、共通の控えは戻さない", async () => {
    givenSharedSaved();
    await launchRestoring([FOLDER]);
    await expect(page).toHaveTitle(`${FOLDER} — PaneDeck`);
    expect(await titles()).toEqual([]);
    await expect(page.getByTestId("session-count")).toHaveText("0 セッション");
  });

  test("フォルダで作ったペインはフォルダの控えに残り、共通の控えは書き換えない。開き直すと戻る", async () => {
    givenSharedSaved();
    const shared = fs.readFileSync(SHARED, "utf8");
    await launchRestoring([FOLDER]);
    await createSession(page, { cwd: FOLDER, shell: NODE, args: STAY_ALIVE, title: "system" });
    await waitForPaneCount(page, 1);

    await expect
      .poll(() => {
        try {
          return JSON.parse(fs.readFileSync(folderSaved(), "utf8")).sessions.map((s: Session) => s.title);
        } catch {
          return null;
        }
      })
      .toEqual(["system"]);
    expect(fs.readFileSync(SHARED, "utf8")).toBe(shared);

    await closeQuietly();
    await launchRestoring([FOLDER]);
    await waitForPaneCount(page, 1);
    expect(await titles()).toEqual(["system"]);
    await closeQuietly();
  });
});

/**
 * サービスもフォルダごと（2026-10-11）。本番のサービスを全体に書くと、開発用の
 * PaneDeck でも動き、並べると二重に動く。設定に読み込まれたかは画面の一覧で見る
 */
test.describe("サービスはフォルダごと", () => {
  /** 起こし直しても害の無い、すぐ終わるコマンド */
  const quick = (name: string, folder?: string) => ({
    name,
    command: `node -e ""`,
    restart: "never",
    ...(folder ? { folder } : {}),
  });
  const serviceNames = () =>
    page.evaluate(async () => (await window.deck.listServices()).map((s) => s.name));

  test("フォルダを開くと、そのフォルダのものだけが動く", async () => {
    await launchWith([FOLDER], [quick("全体"), quick("ここ", FOLDER), quick("よそ", OTHER_FOLDER)]);
    await expect.poll(serviceNames).toEqual(["ここ"]);
  });

  test("フォルダを開かなければ、folder の無いものだけが動く（今までどおり）", async () => {
    await launchWith([], [quick("全体"), quick("ここ", FOLDER)]);
    await expect.poll(serviceNames).toEqual(["全体"]);
  });
});

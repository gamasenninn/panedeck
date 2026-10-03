import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  useFakePty,
  useFakeClock,
  advanceClock,
  createSession,
  emitPtyData,
  writtenTo,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * ファイルが伸びたら、指示待ちのペインへ 1 通送る（#28）。
 *
 * 「指示待ちにだけ届く」「確認待ちには届かない」「何行増えても 1 通」を
 * 実際のアプリで確かめる。中身の解釈はしないので、送られる文面だけを見る。
 */

const TEMP_DIR = path.join(__dirname, "temp-trigger");
const SETTINGS_PATH = path.join(TEMP_DIR, "settings.json");
const QUEUE = path.join(TEMP_DIR, "queue.jsonl");

/** 指示待ちの画面（実機の Claude Code から採取した形） */
const READY_SCREEN = "❯\n⏸ manual mode on · ? for shortcuts";
/** 確認待ちの画面 */
const ASKING_SCREEN = "Do you want to create note.txt?\n❯ 1 Yes\n  3. No";

let electronApp: ElectronApplication;
let page: Page;

async function launchWith(triggers: unknown[]) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(QUEUE, "", "utf8");
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ autoLog: false, autoRestore: false, triggers }),
    "utf8"
  );

  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
  await useFakeClock(electronApp);
}

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

/** 題を付けたペインを 1 枚作り、与えた画面で静止させる */
async function givenPane(titleText: string, screen: string) {
  await createSession(page, { cwd: "/work/queue-a", title: titleText });
  await waitForPaneCount(page, 1);
  await advanceClock(electronApp, 1000);
  await emitPtyData(electronApp, 0, screen);
  await advanceClock(electronApp, 1000);
}

test("行が増えると指示待ちのペインへ届く", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件 last={id}" },
  ]);
  await givenPane("受付", READY_SCREEN);

  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");

  await expect
    .poll(() => writtenTo(electronApp, 0), { timeout: 10000 })
    .toEqual(["新着 1 件 last=m1\r"]);
});

/** 打鍵が回答になる状態へ送ると、指示ではなくダイアログへの返事になる（#27） */
test("確認待ちのペインへは届かない", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件" },
  ]);
  await givenPane("受付", ASKING_SCREEN);

  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");
  await page.waitForTimeout(1500);

  expect(await writtenTo(electronApp, 0)).toEqual([]);
});

test("止まっている間に増えた行は、動けるようになってから 1 通で届く", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件 last={id}" },
  ]);
  await givenPane("受付", ASKING_SCREEN);

  fs.appendFileSync(QUEUE, '{"id":"m1"}\n{"id":"m2"}\n', "utf8");
  await page.waitForTimeout(1500);
  expect(await writtenTo(electronApp, 0)).toEqual([]);

  // 確認に答えて指示待ちへ戻る。ダイアログの文言は判定の窓（末尾 10 行）から
  // 押し出されるまで残るので、実機と同じように出力を流してから静止させる
  const afterAnswer = [
    "⎿  User rejected write to note.txt",
    "✻ Worked for 2s · done",
    "  checked the remaining files",
    "  nothing else to do",
    "  ready for the next instruction",
    "  idle",
    "  waiting",
  ].join("\n");
  await emitPtyData(electronApp, 0, `\n${afterAnswer}\n${READY_SCREEN}`);
  await advanceClock(electronApp, 1000);

  await expect
    .poll(() => writtenTo(electronApp, 0), { timeout: 10000 })
    .toEqual(["新着 2 件 last=m2\r"]);
});

test("既にあった行は送りつけない", async () => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(QUEUE, '{"id":"old"}\n', "utf8");
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      autoLog: false,
      autoRestore: false,
      triggers: [{ watch: QUEUE, pane: { title: "受付" }, send: "{count}" }],
    }),
    "utf8"
  );
  ({ electronApp, page } = await launchApp({ settingsPath: SETTINGS_PATH }));
  await useFakePty(electronApp);
  await useFakeClock(electronApp);

  await givenPane("受付", READY_SCREEN);
  await page.waitForTimeout(1500);

  expect(await writtenTo(electronApp, 0)).toEqual([]);
});

test("ペインに保留の件数が出る", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "{count}" },
  ]);
  await givenPane("受付", ASKING_SCREEN);

  fs.appendFileSync(QUEUE, "a\nb\n", "utf8");

  await expect(page.locator("[data-testid=pane-trigger]")).toHaveText(/2/, {
    timeout: 10000,
  });
});

/** 黙って何もしないトリガーこそ、この機能が取り除きたい失敗 */
test("送り先のペインが無いことが見える", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "居ない係" }, send: "{count}" },
  ]);
  await givenPane("受付", READY_SCREEN);

  await expect(page.locator("[data-testid=trigger-error]")).toContainText(
    "居ない係",
    { timeout: 10000 }
  );
});

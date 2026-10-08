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
  emitPtyExit,
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
    JSON.stringify({
      autoLog: false,
      autoRestore: false,
      // 出来事の記録もここへ（#36）。**実 userData を触らせない**
      logDir: path.join(TEMP_DIR, "logs"),
      triggers,
    }),
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
    // **打つのと確定するのは別の書き込み。** 一度にまとめると貼り付けと
    // 見なされ、CR が改行として入って実行されない（#28 の dogfood）
    .toEqual(["新着 1 件 last=m1", "\r"]);
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
    .toEqual(["新着 2 件 last=m2", "\r"]);
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

/**
 * 出来事がファイルに残ること（#36）。
 *
 * **ツールバーは「いま」を描くだけなので、直れば証拠が消え、閉じれば
 * 全部消える。** 1 日動かした後に何が起きたかを読めるようにする。
 */
test("届け先が無いことがファイルに残る", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "居ない受付" }, send: "新着 {count} 件" },
  ]);
  // ペインは作らない（届け先が無い状態）
  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");

  const eventsFile = () => {
    const dir = path.join(TEMP_DIR, "logs");
    if (!fs.existsSync(dir)) return null;
    const f = fs.readdirSync(dir).find((n) => n.startsWith("events-"));
    return f ? path.join(dir, f) : null;
  };

  await expect
    .poll(
      () => {
        const file = eventsFile();
        return file ? fs.readFileSync(file, "utf8") : "";
      },
      { timeout: 10_000 }
    )
    .toContain("trigger-error");

  const rows = fs
    .readFileSync(eventsFile()!, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const error = rows.find((r) => r.kind === "trigger-error");
  expect(String(error.reason)).toContain("ペインがありません");
  expect(error.title).toBe("居ない受付");
  expect(typeof error.at).toBe("string");

  // **毎周は書かない。** 300ms ごとに書いたら読めない量になる
  await page.waitForTimeout(2000);
  const after = fs
    .readFileSync(eventsFile()!, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.includes("trigger-error"));
  expect(after).toHaveLength(1);
});

test("届いたことが、待った時間つきで残る", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件 last={id}" },
  ]);
  await givenPane("受付", READY_SCREEN);

  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");

  // 打たれたら、ペインが動いたことにする（確認が通る）
  await expect
    .poll(() => writtenTo(electronApp, 0), { timeout: 10_000 })
    .toContain("\r");
  // **画面を消してから**働いている様子を描く。`❯` と `mode on` が残って
  // いると指示待ちのままで、確認が通らない（判定は画面を見る・#31）
  await emitPtyData(electronApp, 0, "\x1b[2J\x1b[H● 作業しています…\r\n");
  await advanceClock(electronApp, 1000);

  const eventsDir = path.join(TEMP_DIR, "logs");
  await expect
    .poll(
      () => {
        const f = fs.readdirSync(eventsDir).find((n) => n.startsWith("events-"));
        return f ? fs.readFileSync(path.join(eventsDir, f), "utf8") : "";
      },
      { timeout: 10_000 }
    )
    .toContain("delivery");

  const f = fs.readdirSync(eventsDir).find((n) => n.startsWith("events-"))!;
  const rows = fs
    .readFileSync(path.join(eventsDir, f), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const delivered = rows.find((r) => r.kind === "delivery");

  expect(delivered.count).toBe(1);
  expect(delivered.title).toBe("受付");
  expect(typeof delivered.waitedMs).toBe("number");
  expect(delivered.submits).toBeGreaterThanOrEqual(1);
});

/**
 * 配達の上限と、人が押す解除（#34 の合意 ① ② ③）。
 *
 * 止めたことが**ツールバーに見え**、**押せば溜まった分が届く**ところまでを
 * 実際のアプリで確かめる。止めたまま自動では戻らないことは単体で見ている。
 */
test("上限に当たると止まり、解除を押すと溜まった分が届く", async () => {
  await launchWith([
    {
      watch: QUEUE,
      pane: { title: "受付" },
      send: "新着 {count} 件 last={id}",
      limit: { count: 1, minutes: 10 },
    },
  ]);
  await givenPane("受付", READY_SCREEN);

  // 1 通目は届く
  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");
  await expect
    .poll(() => writtenTo(electronApp, 0), { timeout: 10_000 })
    .toEqual(["新着 1 件 last=m1", "\r"]);
  await emitPtyData(electronApp, 0, "\x1b[2J\x1b[H● 作業しています…\r\n");
  await advanceClock(electronApp, 1000);
  // **確認が済むまで待ってから**指示待ちへ戻す。すぐ戻すと、300ms ごとの
  // 見回りが作業中の瞬間を一度も見ず、1 通目が確認待ちのまま残る
  await expect
    .poll(async () => (await page.evaluate(() => window.deck.listTriggers()))[0].held, {
      timeout: 10_000,
    })
    .toBe(0);
  await emitPtyData(electronApp, 0, "\x1b[2J\x1b[H" + READY_SCREEN);
  await advanceClock(electronApp, 1000);

  // 2 通目は上限で止まる。理由と解除のボタンが見える
  fs.appendFileSync(QUEUE, '{"id":"m2"}\n', "utf8");
  await expect(page.locator("[data-testid=trigger-error]")).toContainText("上限", {
    timeout: 10_000,
  });
  const release = page.locator("[data-testid=trigger-release]");
  await expect(release).toBeVisible();
  expect(await writtenTo(electronApp, 0)).toEqual(["新着 1 件 last=m1", "\r"]);

  // 押すと届く。捨てていない
  await release.click();
  await expect
    .poll(() => writtenTo(electronApp, 0), { timeout: 10_000 })
    .toContain("新着 1 件 last=m2");
  await expect(release).toBeHidden();
});

/**
 * **閉じるときに偽の失敗を残さない。**
 *
 * 閉じる処理がペインを先に片付けると、その後にトリガーの見回りがもう一度
 * 走り「ペインがありません」と記録していた。実機では**閉じるたびに毎回**
 * 出ていた（10/6・10/8）。後から 1 日を読むための記録に偽の失敗が混ざり、
 * 「直った」の行も対で出ないので、失敗したまま終わったように読める。
 */
test("閉じても「ペインがありません」を記録しない", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件 last={id}" },
  ]);
  await givenPane("受付", READY_SCREEN);
  // 見回りが何周か回ってから閉じる
  await page.waitForTimeout(1000);

  // ★ **実機の隙間を作る。** 本物の pty は後始末に時間がかかり、閉じ始めて
  // からプロセスが消えるまでに見回りが何周も入る。フェイクの pty では一瞬で
  // 終わるので、そのままだと**修正前でも通る**（実際に通った）。アプリ自身の
  // 終了処理が全部走った後で、プロセスの終了だけを遅らせる
  await electronApp.evaluate(({ app }) => {
    app.on("will-quit", (event) => {
      event.preventDefault();
      setTimeout(() => app.exit(0), 1500);
    });
  });

  const app = electronApp;
  electronApp = undefined as unknown as ElectronApplication;
  await closeApp(app);

  const eventsDir = path.join(TEMP_DIR, "logs");
  const written = fs.existsSync(eventsDir)
    ? fs
        .readdirSync(eventsDir)
        .filter((n) => n.startsWith("events-"))
        .map((n) => fs.readFileSync(path.join(eventsDir, n), "utf8"))
        .join("")
    : "";
  expect(written).not.toContain("trigger-error");
});

/**
 * **届け先が終わっていたら黙らない**（2026-10-08）。
 *
 * 単体では状態を文字列で渡して確かめている。ここでは SessionManager が出す
 * 本物の状態（`exited`）で、ツールバーに理由が出ることを見る。
 */
test("届け先のペインが終了していたら、理由が見える", async () => {
  await launchWith([
    { watch: QUEUE, pane: { title: "受付" }, send: "新着 {count} 件 last={id}" },
  ]);
  await givenPane("受付", READY_SCREEN);
  await emitPtyExit(electronApp, 0, 1);

  fs.appendFileSync(QUEUE, '{"id":"m1"}\n', "utf8");

  await expect(page.locator("[data-testid=trigger-error]")).toContainText("終了", {
    timeout: 10_000,
  });
  expect(await writtenTo(electronApp, 0)).toEqual([]);
});

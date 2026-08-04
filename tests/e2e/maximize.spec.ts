import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  emitPtyData,
  writtenTo,
  listSessions,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

let electronApp;
let page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

const panes = () => page.locator(".pane");
const visiblePanes = () => page.locator(".pane:visible");
const maximizeButton = (i: number) =>
  page.locator("[data-testid=pane-maximize]").nth(i);

async function givenPanes(titles: string[]) {
  await resetSessions(electronApp, page);
  for (const title of titles) {
    await createSession(page, { cwd: `C:\\app\\${title}`, title });
  }
  await waitForPaneCount(page, titles.length);
}

test("拡大するとそのペインだけが見える", async () => {
  await givenPanes(["A", "B", "C"]);
  await expect(visiblePanes()).toHaveCount(3);

  await maximizeButton(1).click();

  await expect(visiblePanes()).toHaveCount(1);
  await expect(visiblePanes().locator("[data-testid=pane-title]")).toHaveText("B");
  // 消したわけではない。隠れているだけ
  await expect(panes()).toHaveCount(3);
});

test("もう一度押すと元の並びに戻る", async () => {
  await givenPanes(["A", "B", "C"]);
  await maximizeButton(1).click();
  await expect(visiblePanes()).toHaveCount(1);

  await maximizeButton(1).click();

  await expect(visiblePanes()).toHaveCount(3);
  await expect(page.locator("[data-testid=pane-title]")).toHaveText(["A", "B", "C"]);
});

test("別のペインを拡大すると切り替わる", async () => {
  await givenPanes(["A", "B", "C"]);
  await maximizeButton(0).click();
  await expect(visiblePanes().locator("[data-testid=pane-title]")).toHaveText("A");

  // 隠れているボタンは押せないので、いったん戻してから別を拡大する
  await maximizeButton(0).click();
  await maximizeButton(2).click();

  await expect(visiblePanes()).toHaveCount(1);
  await expect(visiblePanes().locator("[data-testid=pane-title]")).toHaveText("C");
});

test("ボタンの表示が状態に追従する", async () => {
  await givenPanes(["A", "B"]);
  await expect(maximizeButton(0)).toHaveText("拡大");

  await maximizeButton(0).click();
  await expect(maximizeButton(0)).toHaveText("戻す");

  await maximizeButton(0).click();
  await expect(maximizeButton(0)).toHaveText("拡大");
});

test("拡大しても端末は作り直されない", async () => {
  await givenPanes(["A", "B"]);
  await emitPtyData(electronApp, 0, "before maximize\n");
  await expect(page.locator(".pane").first()).toContainText("before maximize");

  await maximizeButton(0).click();

  // 作り直されていれば流れていた出力が消える
  await expect(visiblePanes()).toContainText("before maximize");

  // pty との接続も切れていない
  await page.locator("[data-testid=broadcast-input]").fill("still connected");
  await page.locator("[data-testid=broadcast-send]").click();
  await expect
    .poll(() => writtenTo(electronApp, 0).then((w) => w.join("")))
    .toContain("still connected\r");

  await maximizeButton(0).click();
});

test("拡大すると桁数が増える（再フィットされる）", async () => {
  await givenPanes(["A", "B", "C", "D"]);
  const before = (await listSessions(electronApp))[0];

  await maximizeButton(0).click();

  await expect
    .poll(async () => (await listSessions(electronApp))[0].cols)
    .toBeGreaterThan(before.cols);

  await maximizeButton(0).click();
});

test("拡大中でも一斉送信は全ペインへ届く", async () => {
  // 拡大は見え方の話で、送信先を変えるものではない
  await givenPanes(["A", "B", "C"]);
  await maximizeButton(0).click();

  await expect(page.locator("[data-testid=broadcast-target]")).toHaveText(
    "送信先: 全 3 ペイン"
  );

  await page.locator("[data-testid=broadcast-input]").fill("to everyone");
  await page.locator("[data-testid=broadcast-send]").click();

  for (const i of [0, 1, 2]) {
    await expect
      .poll(() => writtenTo(electronApp, i).then((w) => w.join("")))
      .toContain("to everyone\r");
  }

  await maximizeButton(0).click();
});

test("拡大中のペインを閉じると元の並びに戻る", async () => {
  await givenPanes(["A", "B", "C"]);
  await maximizeButton(1).click();
  await expect(visiblePanes()).toHaveCount(1);

  await visiblePanes().locator("[data-testid=pane-close]").click();
  await waitForPaneCount(page, 2);

  // 拡大したまま何も見えない状態にならないこと
  await expect(visiblePanes()).toHaveCount(2);
  await expect(page.locator("[data-testid=pane-title]")).toHaveText(["A", "C"]);
});

test("拡大中にセッションが増えても隠れたままにならない", async () => {
  await givenPanes(["A", "B"]);
  await maximizeButton(0).click();

  await createSession(page, { cwd: "C:\\app\\C", title: "C" });
  await waitForPaneCount(page, 3);

  // 拡大中なので新しいペインは隠れている
  await expect(visiblePanes()).toHaveCount(1);

  await maximizeButton(0).click();
  await expect(visiblePanes()).toHaveCount(3);
  await expect(page.locator("[data-testid=pane-title]")).toHaveText(["A", "B", "C"]);
});

test("列数の設定は戻したときに復元される", async () => {
  await givenPanes(["A", "B", "C", "D"]);
  await page.locator("[data-testid=columns]").selectOption("2");

  const columnCount = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.getElementById("grid")!).gridTemplateColumns.split(
          " "
        ).length
    );
  await expect.poll(columnCount).toBe(2);

  await maximizeButton(0).click();
  await expect.poll(columnCount).toBe(1);

  await maximizeButton(0).click();
  await expect.poll(columnCount).toBe(2);

  await page.locator("[data-testid=columns]").selectOption("0");
});

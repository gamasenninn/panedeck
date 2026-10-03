import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  useFakePty,
  createSession,
  listSessions,
  resetSessions,
  waitForPaneCount,
} from "./helpers/electron-app";

/**
 * ペインに自分の題を付ける（#28）。
 *
 * 既定の題は作業ディレクトリの末尾なので、同じディレクトリで役割の違う
 * 2 枚を開くと衝突する。トリガーの送り先は題で指すため、付け替えられないと
 * 一意に指せない。
 */

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  await useFakePty(electronApp);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

const title = () => page.locator("[data-testid=pane-title]").first();
const input = () => page.locator("[data-testid=pane-title-input]").first();

async function givenPane(cwd = "/work/repo-a") {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd });
  await waitForPaneCount(page, 1);
}

test("題を二度押しすると編集できる", async () => {
  await givenPane();
  await expect(title()).toHaveText("repo-a");

  await title().dblclick();
  await expect(input()).toBeVisible();
  await expect(input()).toHaveValue("repo-a");
});

test("Enter で確定し、メインプロセスにも届く", async () => {
  await givenPane();
  await title().dblclick();
  await input().fill("レビュー係");
  await input().press("Enter");

  await expect(title()).toHaveText("レビュー係");
  await expect(input()).toBeHidden();

  const sessions = await listSessions(electronApp);
  expect(sessions[0].title).toBe("レビュー係");
});

test("Escape でやめると元のまま", async () => {
  await givenPane();
  await title().dblclick();
  await input().fill("取り消す");
  await input().press("Escape");

  await expect(title()).toHaveText("repo-a");
  const sessions = await listSessions(electronApp);
  expect(sessions[0].title).toBe("repo-a");
});

test("空にすると作業ディレクトリ由来の既定へ戻る", async () => {
  await givenPane();
  await title().dblclick();
  await input().fill("いったん別名");
  await input().press("Enter");
  await expect(title()).toHaveText("いったん別名");

  await title().dblclick();
  await input().fill("");
  await input().press("Enter");

  await expect(title()).toHaveText("repo-a");
});

/** 同じディレクトリの 2 枚を区別できることが、この機能の目的 */
test("同じディレクトリの 2 枚に別々の題を付けられる", async () => {
  await resetSessions(electronApp, page);
  await createSession(page, { cwd: "/work/shared" });
  await createSession(page, { cwd: "/work/shared" });
  await waitForPaneCount(page, 2);

  const titles = page.locator("[data-testid=pane-title]");
  await expect(titles).toHaveText(["shared", "shared"]);

  await titles.nth(0).dblclick();
  await page.locator("[data-testid=pane-title-input]").first().fill("書く係");
  await page.locator("[data-testid=pane-title-input]").first().press("Enter");

  await expect(titles).toHaveText(["書く係", "shared"]);
});

import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

/**
 * scripts/check-delivery.mjs —— id を渡すと、その便が届いたかを日本時間で答える
 * （#37 の一歩、2026-10-10）。送り手が記録を手で探して、ファイル選びと時刻の換算で
 * 間違えていた（本体と受付の 3 往復で、受付が 2 か所）。
 *
 * ★ 実ファイルで動かす。設定とログ置き場は使い捨ての場所に作り、**実 userData は
 * 触らない**（PANEDECK_SETTINGS_PATH で差し替える）。dist を読むのでビルドが要る。
 */
const SCRIPT = path.join(__dirname, "..", "..", "scripts", "check-delivery.mjs");

function workspace(files: Record<string, unknown[]>, mailboxes: Record<string, unknown[]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-check-"));
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs);
  const boxes = path.join(dir, "mailbox");
  fs.mkdirSync(boxes);
  for (const [name, rows] of Object.entries(mailboxes)) {
    fs.writeFileSync(path.join(boxes, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(logs, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, "{}", "utf8");
  return settings;
}

function run(settings: string, id: string) {
  return spawnSync(process.execPath, [SCRIPT, id], {
    encoding: "utf8",
    env: { ...process.env, PANEDECK_SETTINGS_PATH: settings, TZ: "Asia/Tokyo" },
  });
}

test("届いた便は、日本時間で届いた時刻と待ちを出して 0 で終わる", () => {
  const settings = workspace({
    "events-20261010.jsonl": [
      { at: "2026-10-09T18:02:53.743Z", kind: "typed", title: "受付", ids: ["mb-9"] },
      { at: "2026-10-09T18:02:54.666Z", kind: "delivery", title: "受付", ids: ["mb-9"], waitedMs: 923, submits: 1 },
    ],
  });

  const out = run(settings, "mb-9");

  expect(out.status).toBe(0);
  expect(out.stdout).toContain("届いた");
  expect(out.stdout).toContain("受付");
  expect(out.stdout).toContain("2026/10/10 3:02:54"); // UTC 18:02 → 日本時間 3:02
  expect(out.stdout).toContain("923");
  expect(out.stdout).toContain("Asia/Tokyo");
});

/**
 * ★ **submits は Enter を押した回数**で、押し直しの回数ではない（受付の指摘、2026-10-10）。
 * 1 は「1 回押して通った」= 押し直し 0 回。以前は「押し直し 1 回」と出していた
 */
test("Enter の回数と押し直しの回数を取り違えない", () => {
  const settings = workspace({
    "events-20261010.jsonl": [
      { at: "2026-10-09T18:00:00Z", kind: "delivery", title: "受付", ids: ["once"], waitedMs: 900, submits: 1 },
      { at: "2026-10-09T18:01:00Z", kind: "delivery", title: "受付", ids: ["thrice"], waitedMs: 9000, submits: 3 },
    ],
  });

  expect(run(settings, "once").stdout).toContain("Enter 1 回（押し直し 0 回）");
  expect(run(settings, "thrice").stdout).toContain("Enter 3 回（押し直し 2 回）");
});

/** ファイルをまたいでも見つかる。どの日付を見るかを人が決めなくてよい */
test("書いた日と届いた日が違っても見つける", () => {
  const settings = workspace({
    "events-20261009.jsonl": [{ at: "2026-10-09T14:59:00Z", kind: "typed", title: "受付", ids: ["mb-1"] }],
    "events-20261010.jsonl": [
      { at: "2026-10-09T15:30:00Z", kind: "delivery", title: "受付", ids: ["mb-1"], waitedMs: 1860000, submits: 1 },
    ],
  });

  const out = run(settings, "mb-1");

  expect(out.status).toBe(0);
  expect(out.stdout).toContain("届いた");
});

test("見つからなければ、考えられる理由と手がかりを出して 1 で終わる", () => {
  const settings = workspace({
    "events-20261010.jsonl": [
      { at: new Date().toISOString(), kind: "trigger-capped", title: "受付", count: 6, minutes: 10 },
    ],
  });

  const out = run(settings, "mb-x");

  expect(out.status).toBe(1);
  expect(out.stdout).toContain("見つかりません");
  expect(out.stdout).toContain("trigger-capped");
});

/**
 * ★ **道具が機械で確かめられることを先にやり、次の手を 1 つ出す**（受付の指摘、2026-10-10）。
 * 以前は起きうることを並べるだけで、しかもそれは人が見る画面（ツールバー・保留 N）の
 * 話だった。ペインの中のエージェントには確かめようがない
 */
test("どの郵便受けにも書かれていなければ、そう言い切り、綴りを確かめる手を出す", () => {
  const settings = workspace({}, { "受付.jsonl": [{ id: "mb-1" }] });
  const out = run(settings, "mb-typo");
  expect(out.status).toBe(1);
  expect(out.stdout).toContain("どこにも書かれていません");
  expect(out.stdout).toContain("次の手");
  expect(out.stdout).toContain("綴り");
  // 探したファイル名を並べる（宛先の書き間違いに気づける・受付の提案）
  expect(out.stdout).toContain("受付.jsonl");
  // どのファイルを読み直すかを書く
  expect(out.stdout).toContain("宛先の郵便受けの末尾");
});

test("書かれていて止まりの知らせが無ければ、無しと明記し、待ってからもう一度の手を出す", () => {
  const settings = workspace({}, { "受付.jsonl": [{ id: "mb-1" }, { id: "mb-2" }] });
  const out = run(settings, "mb-2");
  expect(out.stdout).toContain("受付.jsonl の 2 行目");
  expect(out.stdout).toContain("止まりの知らせ（この 24 時間）  無し");
  expect(out.stdout).toContain("数分待って");
  // 人が見る画面の話は出さない（エージェントには確かめようがない）
  expect(out.stdout).not.toContain("ツールバー");
});

test("書かれた id が規則から外れていれば、配られないと言い切る", () => {
  const settings = workspace({}, { "受付.jsonl": [{ id: "a b" }] });
  const out = run(settings, "a b");
  expect(out.stdout).toContain("規則から外れて");
  expect(out.stdout).toContain("書き直す");
});

test("id を記録し始める前の行なら、この道具では確かめられないと言う", () => {
  const settings = workspace(
    { "events-20261010.jsonl": [{ at: "2026-10-09T18:00:00Z", kind: "delivery", title: "受付", ids: ["mb-3"] }] },
    { "受付.jsonl": [{ id: "mb-1" }, { id: "mb-2" }, { id: "mb-3" }] }
  );
  const out = run(settings, "mb-1");
  expect(out.stdout).toContain("id を記録し始める前");
  // 「確かめられない」は別の終わり方。エージェントが機械で分けられる（受付の提案）
  expect(out.status).toBe(3);
});

/** 古い行がどこかにあるだけでは言わない（以前は毎回出ていた） */
test("今日書いた id には、id を記録しない頃とは言わない", () => {
  const settings = workspace(
    {
      "events-20261008.jsonl": [{ at: "2026-10-08T14:22:56Z", kind: "delivery", title: "受付", count: 1 }],
      "events-20261010.jsonl": [{ at: "2026-10-09T18:00:00Z", kind: "delivery", title: "受付", ids: ["mb-1"] }],
    },
    { "受付.jsonl": [{ id: "mb-1" }, { id: "mb-2" }] }
  );
  const out = run(settings, "mb-2");
  expect(out.stdout).not.toContain("id を記録し始める前");
});

test("id を渡さなければ使い方を出して 2 で終わる", () => {
  const out = run(workspace({}), "");
  expect(out.status).toBe(2);
});

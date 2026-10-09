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

function workspace(files: Record<string, unknown[]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panedeck-check-"));
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs);
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
      { at: "2026-10-09T18:00:00Z", kind: "trigger-capped", title: "受付", count: 6, minutes: 10 },
    ],
  });

  const out = run(settings, "mb-x");

  expect(out.status).toBe(1);
  expect(out.stdout).toContain("見つかりません");
  expect(out.stdout).toContain("trigger-capped");
});

test("id を記録しない頃の便かもしれないときは、それを真っ先に言う", () => {
  const settings = workspace({
    "events-20261008.jsonl": [{ at: "2026-10-08T14:22:56Z", kind: "delivery", title: "受付", count: 1 }],
  });

  const out = run(settings, "mb-honntai-5");

  expect(out.status).toBe(1);
  const lines = out.stdout.split("\n");
  const first = lines.findIndex((l) => l.includes("id を記録しない"));
  const busy = lines.findIndex((l) => l.includes("作業中"));
  expect(first).toBeGreaterThan(-1);
  expect(first).toBeLessThan(busy);
});

test("id を渡さなければ使い方を出して 2 で終わる", () => {
  const out = run(workspace({}), "");
  expect(out.status).toBe(2);
});

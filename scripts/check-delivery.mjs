#!/usr/bin/env node
/**
 * 便が届いたかを、id から答える（#37 の一歩、2026-10-10）。
 *
 *   node scripts/check-delivery.mjs <id>
 *
 * 送り手は出来事の記録（events-YYYYMMDD.jsonl）を手で探していた。本体と受付の
 * 3 往復で、どのファイルを見るか（配った日付）と時刻の換算（UTC から 9 時間足す）で
 * 受付が 2 か所間違えた。ここでは**記録を全部読む**ので、どの日付を見るかは考えなく
 * てよい。時刻はこのパソコンの時刻（日本時間）で出す。
 *
 * 終わり方: 0 = 届いた / 1 = まだ・届かなかった・見つからない / 2 = 使い方の誤り
 *
 * 判断は lib/delivery-lookup.ts（ビルド済みの dist を読む）。ここは読むだけ。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { lookupDelivery } = require("../dist/lib/delivery-lookup.js");
const { readSettings } = require("../dist/lib/settings.js");

const id = (process.argv[2] ?? "").trim();
if (id === "") {
  console.error("使い方: node scripts/check-delivery.mjs <id>");
  process.exit(2);
}

// 設定の場所は PaneDeck と同じ決め方（試験は PANEDECK_SETTINGS_PATH で差し替える）
const settingsPath =
  process.env.PANEDECK_SETTINGS_PATH ||
  path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "panedeck", "settings.json");
const logDir = readSettings(settingsPath).logDir || path.join(path.dirname(settingsPath), "logs");

const rows = [];
let files = [];
try {
  files = fs.readdirSync(logDir).filter((name) => /^events-\d{8}\.jsonl$/.test(name));
} catch {
  console.log(`記録の置き場所を読めません: ${logDir}`);
  process.exit(1);
}
for (const name of files.sort()) {
  for (const line of fs.readFileSync(path.join(logDir, name), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 壊れた行は飛ばす（書きかけで落ちた行など）
    }
  }
}

const local = (at) => (at ? new Date(at).toLocaleString("ja-JP") : "-");
const result = lookupDelivery(rows, id);

if (result.status === "not-found") {
  console.log(`${id}: 見つかりません（記録 ${files.length} 日分を全部見ました）`);
  console.log("  考えられる理由:");
  if (result.untracked) {
    // ★ 真っ先に言う。届いているのに「作業中・上限…」と並べると見当違いの方へ行く
    console.log("  - id を記録しない頃（2026-10-09 より前）の PaneDeck が配った便かもしれない。");
    console.log("    記録には id が無いので、この道具では探せない（時刻と件数で突き合わせる）");
  }
  console.log("  - 受け手が作業中で、区切りを待っている（ペインに「保留 N」が出ている）");
  console.log("  - 上限で止まっている（ツールバーに「配達を再開」が出ている）");
  console.log("  - id が規則から外れていて配られなかった（英数字とハイフンで 40 字まで）");
  console.log("  - 書いた行が改行で終わっていない / 宛先の郵便受けが違う");
  if (result.hints.length > 0) {
    console.log("  この 24 時間の止まりの知らせ:");
    for (const hint of result.hints) {
      const reason = typeof hint.reason === "string" ? `  ${hint.reason}` : "";
      console.log(`    ${local(hint.at)}  ${hint.kind}  ${hint.title ?? ""}${reason}`);
    }
  }
  process.exit(1);
}

const label = {
  delivered: "届いた（受け手が動いた）",
  typed: "打ったが、まだ確かめている",
  "not-executed": "打ったが実行されなかった（入力欄に残っている。片付ければ打ち直す）",
}[result.status];

console.log(`${id}: ${label}`);
console.log(`  宛先      ${result.title ?? "-"}`);
console.log(`  打った    ${local(result.typedAt)}`);
if (result.deliveredAt) console.log(`  届いた    ${local(result.deliveredAt)}`);
if (result.waitedMs !== undefined) {
  console.log(`  待ち      ${result.waitedMs}ms・押し直し ${result.submits ?? "-"} 回`);
}
if (result.batch && result.batch > 1) console.log(`  一緒に届いた便  ${result.batch} 通`);
process.exit(result.status === "delivered" ? 0 : 1);

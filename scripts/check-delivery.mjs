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
 *         3 = id を記録し始める前の便で、この道具では確かめられない
 *         （1 と分けたのは、エージェントが機械で見分けられるように。受付の提案）
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
const { defaultSettingsPath } = require("../dist/lib/app-paths.js");

const id = (process.argv[2] ?? "").trim();
if (id === "") {
  console.error("使い方: node scripts/check-delivery.mjs <id>");
  process.exit(2);
}

// 設定の場所は PaneDeck（Electron の userData）と同じ決め方。macOS では
// ~/Library/Application Support（以前は ~/.config を見ていて、Mac で見つけられなかった）
const settingsPath = defaultSettingsPath({
  platform: process.platform,
  env: process.env,
  home: os.homedir(),
});
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
// 時刻がどの時間帯かを添える（見た人が UTC と迷わないように）
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// 郵便受けも読む。記録に無いとき、**道具が機械で確かめられることを先にやる**
// （受付の指摘、2026-10-10）。どこにも書かれていなければ、そう言い切れる
const mailboxDir = path.join(path.dirname(settingsPath), "mailbox");
const mailboxes = [];
try {
  for (const name of fs.readdirSync(mailboxDir).filter((n) => n.endsWith(".jsonl"))) {
    const file = path.join(mailboxDir, name);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    mailboxes.push({ file, lines });
  }
} catch {
  // 郵便受けが無い（Tealus の便だけ使っている）。記録だけで答える
}

const result = lookupDelivery(rows, id, Date.now(), mailboxes);

if (result.status === "not-found") {
  console.log(`${id}: 見つかりません（記録 ${files.length} 日分を全部見ました）`);

  // ★ 人が見る画面（ツールバー・保留 N）の話は出さない。ペインの中のエージェントには
  // 確かめようがない。道具が確かめたことと、次の手を 1 つだけ出す
  let next;
  let code = 1;
  if (result.writtenIn) {
    const where = `${path.basename(result.writtenIn.file)} の ${result.writtenIn.line} 行目`;
    console.log(`  郵便受け  ${where}に書かれている`);
  } else if (result.searchedMailboxes > 0) {
    // 探したファイル名を並べる。宛先の書き間違いに気づける（受付の提案）
    const names = mailboxes.map((box) => path.basename(box.file)).join("、");
    console.log(`  郵便受け  どこにも書かれていません（${result.searchedMailboxes} 個を探した: ${names}）`);
    next =
      "id の綴りを確かめる。書いたつもりなら、宛先の郵便受けの末尾を tail -n 1 で読み直し、" +
      "無ければ書き直す";
  } else {
    console.log("  郵便受け  無し（記録だけを見た）");
  }

  if (result.writtenIn && result.badId) {
    console.log("  id        規則から外れているので配られない（英数字とハイフンで 40 字まで）");
    next = "規則どおりの id で書き直す";
  } else if (result.writtenIn && result.untracked) {
    console.log("  この行は id を記録し始める前のもの。届いていても、この道具では確かめられない");
    next = "時刻と件数で記録を突き合わせる。急ぐなら人（小野さん）に聞く";
    code = 3;
  }

  if (result.hints.length === 0) {
    console.log("  止まりの知らせ（この 24 時間）  無し");
  } else {
    console.log("  止まりの知らせ（この 24 時間）");
    for (const hint of result.hints) {
      const reason = typeof hint.reason === "string" ? `  ${hint.reason}` : "";
      console.log(`    ${local(hint.at)}  ${hint.kind}  ${hint.title ?? ""}${reason}`);
    }
  }

  if (!next) {
    next =
      result.hints.length > 0
        ? "止まりの知らせを人（小野さん）に伝える。上限なら人が「配達を再開」を押す"
        : "受け手が作業中で区切りを待っている見込み。数分待って、もう一度この道具を実行する。" +
          "それでも見つからなければ、人（小野さん）に伝える";
  }
  console.log(`  次の手    ${next}`);
  process.exit(code);
}

const label = {
  delivered: "届いた（受け手が動いた）",
  typed: "打ったが、まだ確かめている",
  "not-executed": "打ったが実行されなかった（入力欄に残っている。片付ければ打ち直す）",
}[result.status];

console.log(`${id}: ${label}`);
console.log(`  （時刻は ${zone}）`);
console.log(`  宛先      ${result.title ?? "-"}`);
console.log(`  打った    ${local(result.typedAt)}`);
if (result.deliveredAt) console.log(`  届いた    ${local(result.deliveredAt)}`);
if (result.waitedMs !== undefined) {
  // ★ submits は Enter を押した回数。1 は「1 回で通った」= 押し直し 0 回
  // （以前は「押し直し 1 回」と出していた。受付の指摘で直した）
  const presses =
    typeof result.submits === "number"
      ? `Enter ${result.submits} 回（押し直し ${Math.max(0, result.submits - 1)} 回）`
      : "Enter -";
  console.log(`  待ち      ${result.waitedMs}ms・${presses}`);
}
if (result.batch && result.batch > 1) console.log(`  一緒に届いた便  ${result.batch} 通`);
process.exit(result.status === "delivered" ? 0 : 1);

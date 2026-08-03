/**
 * 保存したセッションログを、状態判定と同じ手順で覗く調査用スクリプト。
 *
 *   node scripts/inspect-log.mjs logs/codex.log
 *
 * detectStatus が実際に見るのは「末尾 TAIL_CHARS を stripAnsi にかけ、
 * その最後の TAIL_LINES 行」なので、同じ加工をしてから中身を出す。
 * 目で見た画面ではなく、判定が受け取る文字列に対してパターンを起こすため。
 */

import fs from "fs";
import path from "path";

const TAIL_CHARS = 2000;
const TAIL_LINES = 10;

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

const WAITING_PATTERNS = [
  [String.raw`│\s*>`, /│\s*>/],
  [String.raw`❯`, /❯/],
  [String.raw`\(y/n\)`, /\(y\/n\)/i],
  [String.raw`\[y/n\]`, /\[y\/n\]/i],
  [String.raw`press enter`, /press enter/i],
];

const file = process.argv[2];
if (!file) {
  console.error("使い方: node scripts/inspect-log.mjs <ログファイル>");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(file), "utf8");
const clean = String(raw).replace(ANSI_PATTERN, "");
const recent = clean.slice(-TAIL_CHARS).split(/\r?\n/).slice(-TAIL_LINES);

console.log(`--- ${file} (${raw.length} chars) ---`);
console.log("=== 判定が見る末尾 10 行（ANSI 除去後・制御文字を可視化）===");
recent.forEach((line, i) => {
  const visible = line
    .replace(/\r/g, "\\r")
    .replace(/\x1b/g, "\\x1b")
    .replace(/[\x00-\x08\x0b-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  console.log(`${String(i).padStart(2)}| ${visible}`);
});

console.log("=== 既定パターンの一致 ===");
const joined = recent.join("\n");
for (const [label, pattern] of WAITING_PATTERNS) {
  console.log(`  ${pattern.test(joined) ? "MATCH  " : "no     "} ${label}`);
}

console.log("=== 末尾行に出てくる記号（コードポイント）===");
const last = recent.filter((l) => l.trim() !== "").pop() ?? "";
const seen = new Map();
for (const ch of last) {
  if (ch.charCodeAt(0) > 0x7f) seen.set(ch, (seen.get(ch) ?? 0) + 1);
}
for (const [ch, count] of seen) {
  console.log(`  ${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} x${count}`);
}

/**
 * 保存したセッションログを、状態判定と同じ手順で覗く調査用スクリプト。
 *
 *   npm run build
 *   node scripts/inspect-log.mjs logs/codex.log [agent]
 *
 * **判定のロジックは再実装せず、ビルド済みの本体を呼ぶ。**
 * 一度ここに写した結果、本体だけ直してスクリプトが古いまま食い違い、
 * 「直したのに直っていない」ように見えた。
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { stripAnsi, detectStatus, TAIL_LINES } = require("../dist/lib/status-detector.js");
const { AGENT_PROFILES, resolveProfile } = require("../dist/lib/agent-profiles.js");

/** SessionManager が判定へ渡す末尾の文字数 */
const TAIL_CHARS = 2000;

const file = process.argv[2];
if (!file) {
  console.error("使い方: node scripts/inspect-log.mjs <ログファイル> [エージェント id]");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(file), "utf8");
const tail = raw.slice(-TAIL_CHARS);

// detectStatus と同じ加工（空行は数に入れない）
const lines = stripAnsi(tail)
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .slice(-TAIL_LINES);

const visible = (line) =>
  line
    .replace(/\r/g, "\\r")
    .replace(/\x1b/g, "\\x1b")
    .replace(/[\x00-\x08\x0b-\x1f]/g, (c) =>
      `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
    );

console.log(`--- ${file} (${raw.length} chars, 判定は末尾 ${TAIL_CHARS}) ---`);
console.log(`=== 判定が見る行（ANSI 除去・空行を除いた末尾 ${TAIL_LINES} 行）===`);
lines.forEach((line, i) => console.log(`${String(i).padStart(2)}| ${visible(line)}`));

console.log("=== プロファイルごとの判定 ===");
for (const profile of AGENT_PROFILES) {
  const status = detectStatus({
    tail,
    msSinceLastOutput: 9999,
    exited: false,
    waitingPatterns: profile.waitingPatterns,
  });
  const hit = profile.waitingPatterns.filter((p) => p.test(lines.join("\n")));
  console.log(
    `  ${profile.id.padEnd(8)} ${status.padEnd(8)} ${hit.map(String).join(" ") || "(一致なし)"}`
  );
}

console.log("=== 判定行に出てくる ASCII 外の記号 ===");
const seen = new Map();
for (const ch of lines.join("")) {
  if (ch.charCodeAt(0) > 0x7f) seen.set(ch, (seen.get(ch) ?? 0) + 1);
}
if (seen.size === 0) console.log("  (なし)");
for (const [ch, count] of seen) {
  console.log(
    `  ${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} x${count}`
  );
}

import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * **CLAUDE.md の地図が実物とずれていないか**（2026-10-10）。
 *
 * CLAUDE.md は次のセッションが最初に読むもので、プロジェクトの構造を載せている。
 * 手で突き合わせたら **14 ファイルが載っていなかった**（トリガーの中心、出来事の記録、
 * 画面の判定、郵便受け、決まりの本体まで）。読んだセッションはトリガーや郵便受けが
 * あることを知らないまま作業を始めることになる。
 *
 * 毎回人手で突き合わせるなら、またずれる。**足したら、ここが落ちて気づく**ようにする。
 * 確かめるのは名前が出てくることだけ（説明の正しさまでは見ない）。
 */
const ROOT = path.join(__dirname, "..", "..");
const MAPPED_DIRS: Array<{ dir: string; ext: RegExp }> = [
  { dir: "lib", ext: /\.ts$/ },
  { dir: "renderer", ext: /\.ts$/ },
  { dir: "scripts", ext: /\.mjs$/ },
  { dir: "docs", ext: /\.md$/ },
];

test("lib・renderer・scripts・docs のファイルは、すべて CLAUDE.md の地図に載っている", () => {
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  const missing = MAPPED_DIRS.flatMap(({ dir, ext }) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((name) => ext.test(name))
      .filter((name) => !claude.includes(name))
      .map((name) => `${dir}/${name}`)
  );

  expect(missing, "CLAUDE.md の「プロジェクト構造」に足すこと").toEqual([]);
});

/**
 * 起動の引数から「開くフォルダ」を決める（2026-10-11）。
 *
 * VS Code の `code <フォルダ>` と同じ考え。フォルダを開いて起動すると、新しいペインも
 * 裏のコマンド（#29）もそこで動く。ペインを足すたびに場所を選ばなくてよい。
 *
 * Electron の argv は、パッケージ版なら [exe, ...引数]、開発時（`electron .`）なら
 * [electron, アプリの場所, ...引数]。Chromium や Playwright のスイッチも混ざるので、
 * `-` で始まるものは読まない。
 *
 * Electron に依存しない。「フォルダか」の判定は注入する。
 */

import path from "path";
import type { OpenFolder } from "../types/panedeck";

export function folderFromArgv(
  argv: string[],
  { defaultApp, isDirectory }: { defaultApp: boolean; isDirectory: (p: string) => boolean }
): OpenFolder {
  // ★ スイッチを先に除いてから飛ばす。Playwright はアプリの場所より前にスイッチを差すので、
  // 逆の順だとアプリの場所を「開くフォルダ」と読む
  const args = argv.filter((arg) => !arg.startsWith("-")).slice(defaultApp ? 2 : 1);
  if (args.length === 0) return {};

  const target = path.resolve(args[0]);
  return isDirectory(target) ? { folder: target } : { missing: target };
}

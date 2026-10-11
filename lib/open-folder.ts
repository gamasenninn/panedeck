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

import crypto from "crypto";
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

/**
 * 構成の控え（last-session.json など）を置く場所（2026-10-11）。
 *
 * フォルダを開いていなければ設定と同じ場所（今までどおり）。開いていれば
 * `folders/<名前>-<ハッシュ>/`。VS Code と同じく、構成はフォルダごとに持つ。
 * 共通の控えを戻すと、`C:\system` を開いたのに本体・受付のペインが出て、
 * 同じ会話を二重に再開した。
 *
 * 名前は人が見て分かるように付けるだけで、区別はハッシュがする
 */
export function folderStateDir(
  baseDir: string,
  folder: string | undefined,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {}
): string {
  if (!folder) return baseDir;
  const key = caseInsensitive ? folder.toLowerCase() : folder;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  const name = path.basename(key) || key.replace(/[^A-Za-z0-9]/g, "") || "root";
  return path.join(baseDir, "folders", `${name}-${hash}`);
}

/**
 * 開いたフォルダで動かすサービス（2026-10-11）。サービスもフォルダごとに持つ。
 *
 * `folder` のあるものはそのフォルダを開いたときだけ、無いものはフォルダを開かずに
 * 起動したときだけ動く。本番のサービスを全体に書くと、開発用の PaneDeck でも動き、
 * 並べると二重に動くため
 */
export function servicesForFolder<T extends { folder?: string }>(
  services: T[],
  folder: string | undefined,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {}
): T[] {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  if (!folder) return services.filter((s) => !s.folder);
  return services.filter((s) => s.folder !== undefined && norm(s.folder) === norm(folder));
}

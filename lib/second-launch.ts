/**
 * 2 つ目の PaneDeck を起動しようとしたとき、1 つ目に出す知らせ（2026-10-11）。
 *
 * 2 つ目は同じ設定を読むので、前回の構成を復元して**同じ会話を二重に再開し**、
 * 裏のコマンドもトリガーも二重に動く。だから 2 つ目は起動しない（main.ts の
 * 単一起動の鍵）。黙って終わると「起動しなかった」ことに気づけないので、1 つ目が
 * 知らせる。フォルダを開いて起動する（`PaneDeck.exe <フォルダ>`）ようになって、
 * 2 つ目を起動したくなる場面が増えた。
 *
 * Electron に依存しない純粋関数。
 */

import type { OpenFolder } from "../types/panedeck";

const BASE = "PaneDeck はすでに動いています。2 つ目は起動しませんでした";

export function secondLaunchNotice(
  current: OpenFolder,
  requested: OpenFolder,
  /** 同じ場所か。Windows では大文字小文字を区別しない比べ方を渡す */
  samePath: (a: string, b: string) => boolean = (a, b) => a === b
): string {
  if (requested.missing) {
    return `${BASE}。指定のフォルダも開けません（無いか、フォルダではない）: ${requested.missing}`;
  }
  if (!requested.folder) return BASE;
  if (current.folder && samePath(requested.folder, current.folder)) return BASE;

  const now = current.folder ? `いまは ${current.folder}` : "いまはフォルダを開いていません";
  return (
    `${BASE}。${requested.folder} は開いていません（${now}）。` +
    "開くには、いったん閉じてから開き直してください"
  );
}

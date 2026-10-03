/**
 * 裏のコマンドの様子を、どう言うか（#29）。
 *
 * **落ち続けていることを隠さない**のがここの仕事。「サービス 2」とだけ
 * 出していると、1 本が 30 秒ごとに落ちて起き直していても同じ見た目になる。
 *
 * 判断は出す、描画は残す —— DOM は読まない純粋関数にして、組み合わせを
 * 単体テストで確かめる。
 */

import type { ServiceState } from "../types/panedeck";

/** 終了コードを人の言葉にする。-1 は「起動そのものに失敗した」印 */
function exitText(code: number | null): string {
  if (code === null) return "";
  return code === -1 ? "起動できず" : `終了コード ${code}`;
}

/**
 * ツールバーに出す 1 行。サービスが無ければ null（何も出さない）。
 *
 * `failing` は目立たせるかどうか。**起こし直し中も「止まった」も異常**として
 * 扱う —— どちらも、置いたはずのものが働いていない状態。
 */
export function serviceSummary(
  states: ServiceState[]
): { text: string; failing: boolean } | null {
  if (states.length === 0) return null;

  const restarting = states.filter((s) => s.status === "restarting");
  const stopped = states.filter((s) => s.status === "stopped");

  const notes: string[] = [];
  if (restarting.length > 0) {
    const total = restarting.reduce((sum, s) => sum + s.restarts, 0);
    notes.push(`再起動中 ${restarting.length}・計 ${total} 回`);
  }
  if (stopped.length > 0) notes.push(`停止 ${stopped.length}`);

  const text = `サービス ${states.length}${notes.length > 0 ? `（${notes.join("・")}）` : ""}`;
  return { text, failing: notes.length > 0 };
}

/** 一覧に出す 1 行 */
export function serviceLabel(state: ServiceState): string {
  const { name, status, restarts, lastExitCode } = state;

  if (status === "running") return `${name} — 実行中`;

  if (status === "restarting") {
    return `${name} — 再起動待ち（${restarts} 回目・${exitText(lastExitCode)}）`;
  }

  const exit = exitText(lastExitCode);
  return `${name} — 停止${exit === "" ? "" : `（${exit}）`}`;
}

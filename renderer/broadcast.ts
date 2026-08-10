/**
 * 一斉入力の送信先の決まり方。
 *
 * 「打った内容が誰に届くか」はこのアプリの主機能で、送る前に読めるのは
 * ツールバーの一行だけ。判断そのものを画面の配線から切り離しておく。
 *
 * DOM も panes も見ない。チェック状態と状態バッジを写した素のデータだけを
 * 受け取る（`clipboard.ts` / `keys.ts` と同じ扱い）。
 */

import type { SessionStatus, BroadcastOptions } from "../types/panedeck";
import { WAITING } from "./constants.js";

/** 送信先を決めるのに要るだけの、ペイン 1 枚ぶんの情報 */
export interface BroadcastPane {
  id: string;
  status: SessionStatus;
  /** チェックボックスが入っているか */
  selected: boolean;
}

/**
 * 送信対象の id。チェックが無ければ null。
 *
 * null は「全ペイン」を意味する。ここで全 id を並べて返さないのは、
 * 状態による絞り込みをメインプロセスに任せているため（レンダラの状態は
 * 300ms ポーリングぶん古くなりうる）。
 *
 * **状態では絞らない。** それは `broadcastOptions` の役目で、
 * 二重に判定すると片方だけ直したときに食い違う。
 */
export function targetIds(panes: BroadcastPane[]): string[] | null {
  const selected = panes.filter((pane) => pane.selected).map((pane) => pane.id);
  return selected.length > 0 ? selected : null;
}

/**
 * 状態による絞り込み。
 *
 * 絞り込み自体はメインプロセスに委ねる。送信可否は、その場で状態を
 * 算出できる側が決める。
 */
export function broadcastOptions(waitingOnly: boolean): BroadcastOptions | undefined {
  return waitingOnly ? { onlyStatus: WAITING } : undefined;
}

/**
 * 動いているペインを止めるためのキー。
 *
 * ツールバーの特殊キーは目的で二手に分かれる。Enter / ↑ / ↓ は**止まって
 * いるペインを進める**もので、入力待ちに絞るのが目的そのもの。対して
 * Esc / Ctrl+C は**動いているペインを止める**もので、入力待ちに絞ると
 * 止めたい相手にだけ届かない（#25）。
 *
 * 入力待ちのペインは、定義上なにも実行していない。
 */
const INTERRUPT_KEYS = new Set(["esc", "ctrl-c"]);

export function isInterruptKey(key: string): boolean {
  return INTERRUPT_KEYS.has(key);
}

/**
 * 特殊キーに当てる絞り込み。
 *
 * 中断のキーだけは「入力待ちのみ」を無視する。**選択（チェックボックス）は
 * どちらのキーでも尊重する** — 選択はその場の明示的な指定で、絞り込みは
 * 入れっぱなしにする類のモードなので、扱いを分ける。
 */
export function optionsForKey(
  key: string,
  waitingOnly: boolean
): BroadcastOptions | undefined {
  return broadcastOptions(waitingOnly && !isInterruptKey(key));
}

/** 送信先が 0 件だったときの説明。 */
export function noTargetMessage(waitingOnly: boolean): string {
  return waitingOnly
    ? "入力待ちのペインがありません"
    : "送信先のペインがありません";
}

/**
 * 送信先の表示。
 *
 * 選択の有無 × 入力待ちのみの有無で 4 通りある。
 */
export function targetLabel(panes: BroadcastPane[], waitingOnly: boolean): string {
  const selected = panes.filter((pane) => pane.selected);
  const scoped = selected.length > 0;
  const targets = scoped ? selected : panes;

  if (!waitingOnly) {
    return scoped
      ? `送信先: 選択 ${targets.length} ペイン`
      : `送信先: 全 ${targets.length} ペイン`;
  }

  const count = targets.filter((pane) => pane.status === WAITING).length;
  return scoped
    ? `送信先: 選択のうち入力待ち ${count} ペイン`
    : `送信先: 入力待ち ${count} ペイン`;
}

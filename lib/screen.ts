/**
 * 判定のための画面（#31）。
 *
 * pty のバイト列を端末エミュレータへ食わせ、**いま見えているもの**を文字列で
 * 返す。判定が長らく見ていた「記録の末尾」は、全画面 TUI では
 * 「最後に塗られた場所」でしかなく、画面とはずれる。実測では、画面に出ている
 * 入力欄の印が窓の 8 倍以上手前にあった。
 *
 * レンダラと**同じ xterm** を使う。解釈が食い違えば、見えているものと判定の
 * 根拠が別物になってしまう。
 *
 * このファイルだけが端末エミュレータを知っている。`SessionManager` は
 * `Screen` という形だけを受け取るので、lib/ の他は依存しないままでいられる。
 */

import { Terminal } from "@xterm/headless";

import type { Screen } from "./session-manager";

/**
 * 画面の高さの上限。
 *
 * 判定が見るのは画面であって履歴ではないので、**スクロールバックは持たない**。
 * 1 セッションにつき 1 つ抱えるため、行数ぶんの記憶がそのまま増える。
 */
const NO_SCROLLBACK = 0;

export function createScreen({ cols, rows }: { cols: number; rows: number }): Screen {
  const term = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    scrollback: NO_SCROLLBACK,
    allowProposedApi: true,
  });

  return {
    write(data: string) {
      term.write(data);
    },

    resize(nextCols: number, nextRows: number) {
      term.resize(Math.max(1, nextCols), Math.max(1, nextRows));
    },

    /**
     * 画面を上から下まで 1 つの文字列にする。
     *
     * 行末の空白は落とす（`translateToString(true)`）。全画面 TUI は画面下を
     * 空白で埋めるので、落とさないと「中身のある行」を数えられない。
     */
    read() {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },

    dispose() {
      term.dispose();
    },
  };
}

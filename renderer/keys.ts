/**
 * 入力欄で改行を入れるためのキー割り当て。
 *
 * 端末は伝統的に `Ctrl+Enter` と `Enter` を区別せず、どちらも CR (0x0D) を
 * 送る（実測でも Ctrl+Enter / Shift+Enter とも `0d` だった）。受け取る側は
 * 同じバイトなので確定と解釈する。区別するには modifyOtherKeys や Kitty の
 * キーボードプロトコルのような拡張が要る。
 *
 * ここでは拡張を実装せず、**改行として通る別のバイト列へ差し替える**。
 */

export interface NewlineKeyEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * 改行として送るバイト列。ESC CR（Alt+Enter と同じ形）。
 *
 * 実機の Claude Code で改行として通ることを確認済み。LF (0x0A) でも通るが、
 * 素のシェルでは LF が確定として扱われるので、そちらは選ばない。
 */
export const NEWLINE_SEQUENCE = "\x1b\r";

/**
 * このキー操作で改行を送るか。送らないなら null。
 *
 * 修飾なしの `Enter` は触らない。奪うと入力を確定する手段が無くなる。
 * `Alt+Enter` も触らない。xterm が既に同じ ESC CR を送っている。
 */
export function newlineSequenceFor(event: NewlineKeyEvent): string | null {
  if (event.type !== "keydown") return null;
  if (event.key !== "Enter") return null;
  if (event.altKey || event.metaKey) return null;

  return event.ctrlKey || event.shiftKey ? NEWLINE_SEQUENCE : null;
}

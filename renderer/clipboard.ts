/**
 * 端末の選択範囲をコピーするかどうかの判定。
 *
 * xterm は入力をそのまま pty へ流すので、何もしないと Ctrl+C は中断
 * （`\x03`）として送られ、コピーにはならない。Electron 既定メニューの
 * Edit → Copy も効かない。あちらは DOM の選択範囲を対象にするが、
 * xterm の選択は DOM の選択ではないため。
 *
 * 判定だけを純粋関数に切り出してある。キーの組み合わせは環境と好みで
 * 揺れるところなので、ここだけを見て確かめられるようにする。
 */

export interface CopyKeyEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * このキー操作でコピーするか。
 *
 * 選択が無いときは常に false を返す。**とくに Ctrl+C を奪わないことが重要**で、
 * 奪うと実行中のコマンドを止める手段が無くなる。選択したうえで Ctrl+C を
 * 押したなら、中断ではなくコピーを意図しているとみなす（Windows Terminal と
 * 同じ振る舞い）。
 */
export function shouldCopySelection(
  event: CopyKeyEvent,
  hasSelection: boolean
): boolean {
  // attachCustomKeyEventHandler は keyup / keypress でも呼ばれる。
  // 拾うのは keydown だけにしないと 1 回の操作で何度も走る
  if (event.type !== "keydown") return false;
  if (!hasSelection) return false;

  const key = event.key.toLowerCase();

  if (key === "insert" && event.ctrlKey) return true;
  if (key !== "c") return false;

  return event.ctrlKey || event.metaKey;
}

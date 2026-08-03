/**
 * 起動コマンド（initialCommand）の正規化。
 *
 * セッション生成時（session-manager）とワークスペースの保存・読み込み
 * （workspace）の両方で同じ規則が要るため、どちらにも寄せずここに置く。
 */

/**
 * 起動コマンドを正規化する。空白だけなら「指定なし」として undefined を返す。
 *
 * 「未指定」と「空文字列」を同じ扱いにまとめることで、呼び出し側は真偽値で
 * 分岐するだけで済む（空なら素のシェルのまま）。
 */
export function normalizeCommand(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

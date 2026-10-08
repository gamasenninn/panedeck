/**
 * トリガーが送る 1 通を組み立てる（#28）。
 *
 * **ここは信頼境界。** 組み上がった文字列は、ユーザーが打ったのと同じ扱いで
 * エージェントの入力欄へ流れる。値に改行が 1 つ混ざれば、そこで入力が確定して
 * 残りが別のメッセージになる。だから置換する値は必ず均す。
 *
 * 置換した中身が誰かの書いたもの（メッセージ本文など）であれば、その人は
 * ユーザーとしてエージェントへ打てることになる。**PaneDeck にはどの項目が
 * 安全かを知る術が無い**ので、ここでは防げない。識別子だけを送り、中身は
 * エージェント自身の道具で取りに行かせること（README に明記）。
 *
 * 状態を持たない純粋関数のみ。
 */

/** 制御文字（改行・CR・ESC・BEL など）。1 つでも通すと入力が確定しうる */
const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g;

/**
 * 置換に使える形へ均す。
 *
 * 制御文字は**空白に置き換える**（除去して詰めると語が繋がって読めなくなる）。
 * 文字列・数値・真偽値だけを受け入れ、それ以外は空にする —— 配列やオブジェクトを
 * 文字列化しても意味のある文にならないため。
 */
export function sanitizeValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  return String(value).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * `{名前}` を値で置き換える。
 *
 * **解決できない名前はそのまま残す。** 空にすると「値が空だった」のか
 * 「名前を間違えた」のかが区別できず、黙って壊れたまま動き続ける。
 */
export function renderTemplate(
  template: string,
  values: Record<string, unknown>
): string {
  const filled = String(template ?? "").replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? sanitizeValue(values[name]) : whole
  );

  // テンプレート自体の改行も落とす。送信は 1 通であるべき
  return filled.replace(CONTROL_CHARS, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * 保留していた行から、テンプレートに渡す値を作る。
 *
 * `{count}` は届ける行数。各フィールドは**最後の行**から採る（「最新の 1 件を
 * 指して、まとめて何件」を 1 通で言うため）。JSON でない行は `{line}`。
 */
export function templateValues(lines: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = { count: lines.length };
  const last = lines[lines.length - 1];
  if (last === undefined) return values;

  values.line = last;

  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return values;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return values;

  // 最上位だけ。入れ子を平らにすると、どの項目を指しているかが読めなくなる
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "count" || key === "line") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
    }
  }

  return values;
}

/**
 * 識別子として打ってよい形。英数字とハイフンで 40 字まで。
 *
 * Tealus の id（UUID・36 字）はこれに収まる。実機の queue は全班 2914 行が
 * すべて通った。
 */
const SAFE_ID = /^[A-Za-z0-9-]{1,40}$/;

/**
 * この行の `{id}` を打ってよいか。打てないなら理由、打てるなら null。
 *
 * **`{id}` は人が打った文として届く**（#34 の合意 ⑥）。Tealus の id は
 * サーバが発行した値だったので気にしなくてよかったが、郵便受けの id は
 * **書き手が自由に書ける**。制御文字を落としても文章は通るので、id に
 * 指示を書けば、受け手には人の指示と区別できない形で打ち込まれる。
 *
 * - 文面が `{id}` を使わないなら調べない（何を書かれても打たれない）
 * - id が無い・JSON でない行も止める（`{id}` がそのまま打たれるだけで意味が無い）
 * - ★ **理由に中身を写さない。** 記録に残すと、そこが次の運び屋になる
 */
export function idProblem(line: string, template: string): string | null {
  if (!/\{id\}/.test(String(template ?? ""))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "JSON でない行";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "JSON でない行";
  }

  const id = (parsed as Record<string, unknown>).id;
  if (id === undefined) return "id が無い行";
  if (typeof id !== "string" && typeof id !== "number") return "id が識別子の形でない行";
  if (!SAFE_ID.test(String(id))) {
    return "id が識別子の形でない行（英数字とハイフンで 40 字まで）";
  }
  return null;
}

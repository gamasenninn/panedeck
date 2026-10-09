/**
 * id を渡すと、その便がどうなったかを答える（#37 の一歩、2026-10-10）。
 *
 * 送り手は「届いたか」を出来事の記録で探していた。本体と受付の 3 往復で、
 * **どのファイルを見るか（配った日付）と時刻の換算（UTC から 9 時間足す）で、
 * 受付が 2 か所間違えた**。手順を決まりに書いても、毎回人手でやるならまた間違える。
 *
 * ここは記録の行から判断するだけ（純粋関数）。ファイルを読むのは
 * scripts/check-delivery.mjs。**ファイルは全部読む**ので、どの日付を見るかは
 * そもそも考えなくてよい。
 */

export interface EventRow {
  kind: string;
  at: string;
  title?: string;
  watch?: string;
  ids?: unknown;
  waitedMs?: unknown;
  submits?: unknown;
  reason?: unknown;
  /** 出来事ごとに項目が違う（count など）。知らないものはそのまま持つ */
  [key: string]: unknown;
}

export type DeliveryStatus = "delivered" | "typed" | "not-executed" | "not-found";

export interface DeliveryResult {
  status: DeliveryStatus;
  title?: string;
  watch?: string;
  typedAt?: string;
  deliveredAt?: string;
  waitedMs?: number;
  submits?: number;
  /** 一緒に届いた便の数（まとめて 1 通で配られる） */
  batch?: number;
  /** 見つからないときの手がかり。止まりの知らせ（上限・規則違反・届け先） */
  hints: EventRow[];
  /**
   * id の無い配達の行が記録にある。**id を記録しない頃に配られた便は探せない**
   * （実機で踏んだ: 10/8 に確かに届いた便が「見つかりません」になり、作業中・上限…と
   * 見当違いの理由を並べた）
   */
  untracked: boolean;
}

/** 見つからないときに手がかりとして見せる出来事 */
const HINT_KINDS = new Set(["trigger-capped", "trigger-rejected", "trigger-error"]);
const HINT_LIMIT = 5;
/** 手がかりに出す止まりの知らせの古さの上限。古いものは今の配達と関係が無い */
const HINT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 配った・打った・諦めたの行で、id を持たないもの（ids が入る前の記録） */
function isUntracked(row: EventRow): boolean {
  return (
    (row.kind === "delivery" || row.kind === "typed" || row.kind === "not-executed") &&
    !Array.isArray(row.ids)
  );
}

function carries(row: EventRow, id: string): boolean {
  return Array.isArray(row.ids) && row.ids.includes(id);
}

/**
 * その id の便がどうなったか。**最後の出来事が答え**（諦めた後に人が入力欄を
 * 片付けると打ち直して届くので、途中の not-executed で決めない）。
 */
export function lookupDelivery(
  rows: EventRow[],
  id: string,
  now: number = Date.now()
): DeliveryResult {
  const mine = rows
    .filter((row) => carries(row, id))
    .sort((a, b) => a.at.localeCompare(b.at));

  if (mine.length === 0) {
    const hints = rows
      .filter((row) => HINT_KINDS.has(row.kind))
      .filter((row) => now - Date.parse(row.at) <= HINT_WINDOW_MS)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-HINT_LIMIT);
    return { status: "not-found", hints, untracked: rows.some(isUntracked) };
  }

  const last = mine[mine.length - 1];
  const typed = [...mine].reverse().find((row) => row.kind === "typed");
  const result: DeliveryResult = {
    status: "typed",
    title: last.title,
    watch: last.watch,
    typedAt: typed?.at,
    batch: Array.isArray(last.ids) ? last.ids.length : undefined,
    hints: [],
    untracked: false,
  };

  if (last.kind === "delivery") {
    result.status = "delivered";
    result.deliveredAt = last.at;
  } else if (last.kind === "not-executed") {
    result.status = "not-executed";
  }
  if (typeof last.waitedMs === "number") result.waitedMs = last.waitedMs;
  if (typeof last.submits === "number") result.submits = last.submits;
  return result;
}

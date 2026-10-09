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

import { safeIdOf } from "./trigger-template";

/** 郵便受け 1 つ分の中身（ファイルと、その行） */
export interface MailboxContent {
  file: string;
  lines: string[];
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
  /** 郵便受けのどこに書かれていたか（行は 1 始まり）。どこにも無ければ undefined */
  writtenIn?: { file: string; line: number };
  /** 探した郵便受けの数。0 なら「書かれていない」とは言い切れない */
  searchedMailboxes: number;
  /** 書かれた行の id が規則から外れている（英数字とハイフンで 40 字まで）。配られない */
  badId: boolean;
}

/** 見つからないときに手がかりとして見せる出来事 */
const HINT_KINDS = new Set(["trigger-capped", "trigger-rejected", "trigger-error"]);
const HINT_LIMIT = 5;
/** 手がかりに出す止まりの知らせの古さの上限。古いものは今の配達と関係が無い */
const HINT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 行の id（形を問わず、文字列か数値なら）。JSON でなければ null */
function rawIdOf(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    const id = parsed && typeof parsed === "object" ? parsed.id : undefined;
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * その郵便受けで、記録に id が残っている最初の行（0 始まり）。無ければ -1。
 *
 * これより前の行は、**id を記録しない頃の PaneDeck が配った**かもしれない。
 * 以前は記録の 30 日の中に古い行が 1 行でもあれば毎回そう言い、今日書いた id でも
 * 見当違いの方へ誘っていた（受付の指摘）
 */
function firstTrackedLine(lines: string[], tracked: Set<string>): number {
  return lines.findIndex((line) => {
    const id = rawIdOf(line);
    return id !== null && tracked.has(id);
  });
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
  now: number = Date.now(),
  mailboxes: MailboxContent[] = []
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

    // **郵便受けから探す**。どこにも無ければ「そもそも書かれていない」と言い切れる
    let writtenIn: DeliveryResult["writtenIn"];
    let badId = false;
    let untracked = false;
    for (const box of mailboxes) {
      const index = box.lines.findIndex((line) => rawIdOf(line) === id);
      if (index === -1) continue;
      writtenIn = { file: box.file, line: index + 1 };
      badId = safeIdOf(box.lines[index]) === null;

      const tracked = new Set(
        rows.flatMap((row) => (Array.isArray(row.ids) ? (row.ids as string[]) : []))
      );
      const first = firstTrackedLine(box.lines, tracked);
      untracked = first !== -1 && index < first;
      break;
    }

    return {
      status: "not-found",
      hints,
      untracked,
      writtenIn,
      searchedMailboxes: mailboxes.length,
      badId,
    };
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
    searchedMailboxes: mailboxes.length,
    badId: false,
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

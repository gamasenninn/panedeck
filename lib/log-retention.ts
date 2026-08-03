import fs from "fs";
import path from "path";

/**
 * 溜まったログの片付け。
 *
 * **PaneDeck が作ったログ以外は絶対に消さない。** そのために、書き出したファイルを
 * 索引に記録し、**索引に載っているものだけ**を削除の候補にする。
 *
 * ファイル名の形（`<タイトル>-YYYYMMDD-HHmmss.log`）で判別する手もあるが、
 * それは推測でしかない。出力先はユーザーが設定で変えられるので、そこに置かれた
 * 別のファイルがたまたま同じ形をしている可能性を排除できない。索引なら
 * 「自分が作った」という事実そのものを根拠にできる。
 *
 * 索引が読めないときは何も消さない。証拠が無い状態で消すより、片付かないほうがよい。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface LogIndexEntry {
  /** 出力先の絶対パス */
  file: string;
  /** 書き出しを始めた時刻 (ms) */
  createdAt: number;
}

export interface RetentionPolicy {
  /** 保持日数。0 なら期間では消さない */
  maxAgeDays: number;
  /** 合計サイズの上限 (bytes)。0 ならサイズでは消さない */
  maxTotalBytes: number;
}

export interface CleanupResult {
  deleted: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * 索引を読む。無い・壊れている・形が違う、のいずれでも空を返す。
 */
export function readIndex(indexPath: string): LogIndexEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (entry): entry is LogIndexEntry =>
        entry &&
        typeof entry.file === "string" &&
        entry.file !== "" &&
        Number.isFinite(entry.createdAt)
    );
  } catch {
    return [];
  }
}

/** 索引を書く。失敗しても投げない（記録できないだけで、書き出し自体は続く）。 */
function writeIndex(indexPath: string, entries: LogIndexEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // 索引が残らないと、そのぶんは片付けの対象外になるだけ。
    // 「消せない」方向に倒れるので実害は小さい
  }
}

/**
 * 書き出したファイルを索引に載せる。
 *
 * ログの書き出し自体を止めたくないので、失敗しても投げない。
 */
export function addToIndex(
  indexPath: string,
  filePath: string,
  createdAt: number
): void {
  const entries = readIndex(indexPath);
  if (entries.some((entry) => entry.file === filePath)) return;

  entries.push({ file: filePath, createdAt });
  writeIndex(indexPath, entries);
}

/**
 * 消すべきファイルを選ぶ。副作用は持たない。
 *
 * 期間とサイズは独立に効き、どちらか一方でも該当すれば対象。サイズ超過のときは
 * 古いものから順に消す。**最新の 1 つは必ず残す**（それを消しても上限に収まらない
 * 場合、いま書いているログまで消えてしまうため）。
 */
export function selectForDeletion(
  entries: Array<LogIndexEntry & { size: number }>,
  policy: RetentionPolicy,
  now: number
): string[] {
  const remove = new Set<string>();

  // 古い順に並べる。以降どちらの判定もこの順で見る
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);

  if (policy.maxAgeDays > 0) {
    const limit = now - policy.maxAgeDays * DAY_MS;
    for (const entry of sorted) {
      if (entry.createdAt < limit) remove.add(entry.file);
    }
  }

  if (policy.maxTotalBytes > 0) {
    let total = sorted.reduce((sum, entry) => sum + entry.size, 0);

    for (const entry of sorted) {
      if (total <= policy.maxTotalBytes) break;
      // 最新の 1 つは残す
      if (entry === sorted[sorted.length - 1]) break;
      if (!remove.has(entry.file)) total -= entry.size;
      remove.add(entry.file);
    }
  }

  return sorted.filter((entry) => remove.has(entry.file)).map((entry) => entry.file);
}

/**
 * 索引に載っているログのうち、方針から外れたものを消す。
 *
 * 例外は投げない。片付けに失敗してもアプリの起動を止めるべきではない。
 */
export function cleanupLogs({
  indexPath,
  policy,
  now = () => Date.now(),
}: {
  indexPath: string;
  policy: RetentionPolicy;
  now?: () => number;
}): CleanupResult {
  const result: CleanupResult = { deleted: [], failed: [] };

  const entries = readIndex(indexPath);
  if (entries.length === 0) return result;

  // 既に消えているものは索引から外す。サイズも同時に取る
  const alive: Array<LogIndexEntry & { size: number }> = [];
  let indexChanged = false;

  for (const entry of entries) {
    try {
      alive.push({ ...entry, size: fs.statSync(entry.file).size });
    } catch {
      // 手で消された・移動された。索引から落とすだけ
      indexChanged = true;
    }
  }

  const targets =
    policy.maxAgeDays > 0 || policy.maxTotalBytes > 0
      ? new Set(selectForDeletion(alive, policy, now()))
      : new Set<string>();

  const kept: LogIndexEntry[] = [];
  for (const entry of alive) {
    if (!targets.has(entry.file)) {
      kept.push({ file: entry.file, createdAt: entry.createdAt });
      continue;
    }

    try {
      fs.unlinkSync(entry.file);
      result.deleted.push(entry.file);
      indexChanged = true;
    } catch (err) {
      result.failed.push({ file: entry.file, error: (err as Error).message });
      // 消せなかったものは索引に残す。次回また試せる
      kept.push({ file: entry.file, createdAt: entry.createdAt });
    }
  }

  if (indexChanged) writeIndex(indexPath, kept);

  return result;
}

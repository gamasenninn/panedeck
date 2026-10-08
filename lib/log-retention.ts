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
 *
 * **見るだけの用途向け。** 書き戻す側は `loadIndex` で「無い」と「読めない」を
 * 見分けること —— 空を返されたまま足して書くと、索引が丸ごと消える。
 */
export function readIndex(indexPath: string): LogIndexEntry[] {
  const loaded = loadIndex(indexPath);
  return loaded.state === "ok" ? loaded.entries : [];
}

type LoadedIndex =
  | { state: "ok"; entries: LogIndexEntry[] }
  /** まだ作られていない。空から始めてよい */
  | { state: "missing" }
  /** 読めたが JSON として壊れている。待っても直らない */
  | { state: "corrupt" }
  /** 読めなかった（他が掴んでいる等）。**待てば読める**ので触らない */
  | { state: "unreadable" };

/**
 * 索引を読み、**「無い」と「読めない」を見分けて**返す（2026-10-08）。
 *
 * 以前はどちらも空として扱っていたので、一瞬読めなかったときに 1 件足すと
 * **それまでの索引が丸ごと消えた**。実機では 8/10〜9/21 のログ 36 個が索引から
 * 外れ、30 日を過ぎても片付けられずに残っていた。
 */
function loadIndex(
  indexPath: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")
): LoadedIndex {
  let text: string;
  try {
    text = readFile(indexPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: "corrupt" };
  }
  if (!Array.isArray(raw)) return { state: "corrupt" };

  return {
    state: "ok",
    entries: raw.filter(
      (entry): entry is LogIndexEntry =>
        entry &&
        typeof entry.file === "string" &&
        entry.file !== "" &&
        Number.isFinite(entry.createdAt)
    ),
  };
}

/**
 * 索引を書く。失敗しても投げない（記録できないだけで、書き出し自体は続く）。
 *
 * **一時ファイルに書いてから置き換える。** 直接書くと、途中で落ちたときに
 * 壊れた JSON が残り、次に読んだときに「壊れている」になる。
 */
function writeIndex(indexPath: string, entries: LogIndexEntry[]): void {
  const temp = `${indexPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(entries, null, 2), "utf8");
    fs.renameSync(temp, indexPath);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 片付けられないだけ
    }
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
  createdAt: number,
  { readFile }: { readFile?: (file: string) => string } = {}
): void {
  const loaded = loadIndex(indexPath, readFile);

  // ★ **読めないときは書かない。** 空とみなして足すと、それまでの索引が
  // 丸ごと消える。このファイルが載らないだけで済ませる（消せない側に倒れる）
  if (loaded.state === "unreadable") return;

  // 壊れていたら**退避してから**作り直す。黙って上書きすると、何が起きたかも
  // 何が載っていたかも分からなくなる
  if (loaded.state === "corrupt") {
    try {
      fs.renameSync(indexPath, `${indexPath}.broken-${Date.now()}`);
    } catch {
      return; // 退避できないなら触らない
    }
  }

  const entries = loaded.state === "ok" ? loaded.entries : [];
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
  statSize = (file) => fs.statSync(file).size,
}: {
  indexPath: string;
  policy: RetentionPolicy;
  now?: () => number;
  /** 大きさを測る。テストから「開けない」を作るために差し替えられる */
  statSize?: (file: string) => number;
}): CleanupResult {
  const result: CleanupResult = { deleted: [], failed: [] };

  const entries = readIndex(indexPath);
  if (entries.length === 0) return result;

  // 既に消えているものは索引から外す。サイズも同時に取る
  const alive: Array<LogIndexEntry & { size: number }> = [];
  let indexChanged = false;

  // 開けなかったが、無くなったとは言えないもの。**索引に残し、消さない**
  const unknown: LogIndexEntry[] = [];

  for (const entry of entries) {
    try {
      alive.push({ ...entry, size: statSize(entry.file) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // 手で消された・移動された。索引から落とすだけ
        indexChanged = true;
      } else {
        // ★ 一時的に開けなかっただけかもしれない。「消された」とみなして
        // 落とすと、二度と片付けの対象に戻らない（2026-10-08）
        unknown.push(entry);
      }
    }
  }

  const targets =
    policy.maxAgeDays > 0 || policy.maxTotalBytes > 0
      ? new Set(selectForDeletion(alive, policy, now()))
      : new Set<string>();

  const kept: LogIndexEntry[] = [...unknown];
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

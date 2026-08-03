import fs from "fs";
import path from "path";

import { stripAnsi as stripAnsiText } from "./status-detector";
import { addToIndex } from "./log-retention";

/**
 * セッションの出力をファイルへ書き出す。
 *
 * Electron に依存しない。出力先ディレクトリと時計は注入され、書き込みの
 * タイミング（どれくらいの間隔で flush するか）は呼び出し側が決める。
 * pty の出力は高頻度なので、受け取るたびに fs を呼ばずバッファへ溜め、
 * まとめて追記する。
 */

/** ファイル名として使えない文字（Windows の禁止文字を含む） */
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** ファイル名の上限（拡張子と時刻を含む） */
const MAX_NAME_LENGTH = 120;

export interface LogFailure {
  id: string;
  filePath: string;
  error: string;
}

/** 時刻を `YYYYMMDD-HHmmss` にする（ローカル時刻）。 */
function timestamp(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");

  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

/**
 * ログファイル名を作る。
 *
 * どのセッションのいつの記録かが名前だけで分かるように、タイトルと起動時刻を
 * 含める。タイトルはユーザーが付けるので、そのままではファイル名に使えない
 * 文字が混ざりうる。
 */
export function logFileName(title: string, time: number): string {
  const suffix = `-${timestamp(time)}.log`;

  const safe = String(title ?? "")
    .replace(UNSAFE_CHARS, "_")
    .trim();
  const base = safe === "" ? "session" : safe;

  return `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

export interface LogWriterDeps {
  /** 出力先ディレクトリ */
  dir: string;
  /** 現在時刻 (ms) */
  now?: () => number;
  /** ANSI エスケープを除去して書くか */
  stripAnsi?: boolean;
  /**
   * 作ったファイルを記録する索引の場所。
   *
   * 片付け（lib/log-retention）は索引に載っているものしか消さない。
   * 渡さなければ記録しない＝そのログは片付けの対象にならない。
   */
  indexPath?: string;
}

export class LogWriter {
  dir: string;
  now: () => number;
  stripAnsi: boolean;
  indexPath?: string;

  /** セッション id → 出力先パス */
  paths = new Map<string, string>();
  /** セッション id → 未書き込みの出力 */
  buffers = new Map<string, string>();
  /** 書き込みに失敗して諦めたセッション */
  failed = new Set<string>();

  constructor({
    dir,
    now = () => Date.now(),
    stripAnsi = true,
    indexPath,
  }: LogWriterDeps) {
    this.dir = dir;
    this.now = now;
    this.stripAnsi = stripAnsi;
    this.indexPath = indexPath;
  }

  /**
   * セッションの記録を開始し、出力先パスを返す。
   *
   * ファイルはまだ作らない。出力が無いまま閉じたセッションで空ファイルが
   * 散らかるのを避ける。
   */
  open(id: string, title: string): string {
    const startedAt = this.now();
    const filePath = this._uniquePath(logFileName(title, startedAt));

    this.paths.set(id, filePath);
    this.buffers.set(id, "");
    this.failed.delete(id);

    // 片付けの根拠になる記録。失敗しても投げない（記録が残らないぶんは
    // 片付けの対象外になるだけで、書き出しは続けられる）
    if (this.indexPath) addToIndex(this.indexPath, filePath, startedAt);

    return filePath;
  }

  /** 出力を溜める。開いていない・諦めたセッションのぶんは捨てる。 */
  append(id: string, data: string): void {
    if (!this.paths.has(id) || this.failed.has(id)) return;

    const text = this.stripAnsi ? stripAnsiText(data) : data;
    this.buffers.set(id, this.buffers.get(id)! + text);
  }

  /**
   * 溜まっている出力をまとめて追記する。
   *
   * 例外は投げない。ログが書けないことでセッションの操作を止めるべきではない。
   * 失敗したセッションは以降の書き込みをやめる。出力のたびに失敗し続けると
   * 通知が止まらなくなるため。
   *
   * @returns 失敗した分
   */
  flush(): LogFailure[] {
    const failures: LogFailure[] = [];

    for (const [id, buffered] of this.buffers) {
      if (buffered === "" || this.failed.has(id)) continue;

      const filePath = this.paths.get(id)!;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, buffered, "utf8");
        this.buffers.set(id, "");
      } catch (err) {
        this.failed.add(id);
        this.buffers.set(id, "");
        failures.push({ id, filePath, error: (err as Error).message });
      }
    }

    return failures;
  }

  /** 1 セッションの記録を終える（書き残しを吐き出してから忘れる）。 */
  close(id: string): LogFailure[] {
    const failures = this.flush().filter((failure) => failure.id === id);

    this.paths.delete(id);
    this.buffers.delete(id);
    this.failed.delete(id);

    return failures;
  }

  /** 全セッションの記録を終える。 */
  closeAll(): LogFailure[] {
    const failures = this.flush();

    this.paths.clear();
    this.buffers.clear();
    this.failed.clear();

    return failures;
  }

  /**
   * 既に同名のファイルがあれば連番で避ける。
   *
   * 同じ秒に同じタイトルのセッションを開くと衝突し、片方の記録が
   * もう片方に混ざってしまう。
   */
  private _uniquePath(fileName: string): string {
    const used = new Set(this.paths.values());
    const ext = path.extname(fileName);
    const base = fileName.slice(0, -ext.length);

    let candidate = path.join(this.dir, fileName);
    let n = 1;
    while (used.has(candidate) || fs.existsSync(candidate)) {
      n += 1;
      candidate = path.join(this.dir, `${base}-${n}${ext}`);
    }

    return candidate;
  }
}

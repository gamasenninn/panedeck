/**
 * 出来事の記録（#36）。
 *
 * **見せるだけでは残らない。** ツールバーはいまの状態を 300ms ごとに描き直す
 * 表示なので、**直れば証拠が消え、閉じれば全部消える**。夜中に「ペインが
 * ありません」が出ていても、朝には知る術がなかった。
 *
 * ここは**出来事だけ**を 1 行ずつ残す。毎周の状態は書かない —— 300ms × 枚数を
 * 書けば読めない量になる。**静かな日はほぼ何も増えない**のが狙いで、だから
 * 後から読める。
 *
 * ★ **記録が書けないことで、届けるのをやめてはいけない。** 書き込みの失敗は
 * 投げずに数えるだけにする。記録は後から読むためのもので、配達より大事では
 * ない。
 *
 * Electron に依存しない。出力先も時計も注入される。
 */

import fs from "fs";
import path from "path";

import { addToIndex } from "./log-retention";

export interface EventLogDeps {
  /** 出力先ディレクトリ（ペインの記録と同じ場所） */
  dir: string;
  /**
   * 片付けの索引（lib/log-retention）。
   *
   * 渡せば登録して**保持期間の対象になる**。渡さなければ消されない。
   */
  indexPath?: string;
  now?: () => number;
  /** 追記。テストから差し替えられるように */
  append?: (file: string, line: string) => void;
}

/** 1 行に書く中身。`kind` 以外は出来事ごとに自由 */
export type LogEvent = { kind: string } & Record<string, unknown>;

export class EventLog {
  private dir: string;
  private indexPath?: string;
  private now: () => number;
  private append: (file: string, line: string) => void;
  /** 書けなかった回数。黙って捨てたことにしない */
  failed = 0;
  /** 索引へ登録済みのファイル。同じ日に何度も書かない */
  private registered = new Set<string>();

  constructor({ dir, indexPath, now, append }: EventLogDeps) {
    this.dir = dir;
    this.indexPath = indexPath;
    this.now = now ?? (() => Date.now());
    this.append =
      append ??
      ((file, line) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, "utf8");
      });
  }

  /**
   * その日のファイル。ペインの記録と同じく日付で分ける。
   *
   * ★ **日の境目はローカルの深夜。** `log-writer` のファイル名もローカル時刻で
   * 付くので、同じフォルダに並ぶ 2 種類が別の日で切れてはいけない。
   *
   * UTC で切ると、JST では `events-20261006.jsonl` が **10/6 09:00 〜 10/7 09:00**
   * を抱える。朝に「今日」を読もうとして昨日の名前を開くことになり、
   * **「後から 1 日を読む」という #36 の目的そのものが欠ける**。
   *
   * 行の中の `at` は UTC の ISO のまま。**瞬間は絶対で、束ね方だけがローカル。**
   */
  private fileFor(at: number): string {
    const d = new Date(at);
    const stamp =
      String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    return path.join(this.dir, `events-${stamp}.jsonl`);
  }

  write(event: LogEvent): void {
    const at = this.now();
    const file = this.fileFor(at);

    try {
      this.append(file, JSON.stringify({ at: new Date(at).toISOString(), ...event }) + "\n");
    } catch {
      // 書けなかっただけ。**配達は続ける**
      this.failed += 1;
      return;
    }

    if (this.indexPath && !this.registered.has(file)) {
      this.registered.add(file);
      try {
        addToIndex(this.indexPath, file, at);
      } catch {
        // 索引に載らないだけ（片付けの対象から漏れる）。書けてはいる
      }
    }
  }
}

/**
 * 動いている PaneDeck が古いか（ビルドが新しくなったか）を見る（2026-10-10）。
 *
 * 修正のたびに「次に再起動したときに効く」と言い、再起動して、新しいビルドで
 * 動いているかを道具で確かめる、を 1 日に 10 回近くくり返した。一度は「再起動した」
 * のにプロセスが前のままだった。古いデッキは設定を書き戻すときに知らない項目を
 * 消すので、再起動の段取りまで人に頼む必要があった。**画面で分かれば要らない。**
 *
 * ★ **中身で比べる。** 試験（npm test）は毎回ビルドし直すので、中身が同じでも
 * 更新日時は変わる。日時で見ると、試験を回すたびに「新しいビルドあり」が出る。
 * 日時は「中身を比べ直すかどうか」の目安にだけ使う（毎回全部は読まない）。
 *
 * Electron に依存しない。見る場所は注入する。
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

interface Snapshot {
  /** ファイル → 更新日時。比べ直すかの目安 */
  times: Map<string, number>;
  /** 中身の指紋 */
  digest: string;
}

/** `.js` だけを集める（`.map` や `.d.ts` の出入りで騒がない） */
function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

function snapshot(dir: string): Snapshot {
  const files = listJs(dir);
  const times = new Map<string, number>();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    times.set(file, fs.statSync(file).mtimeMs);
    hash.update(path.relative(dir, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return { times, digest: hash.digest("hex") };
}

function sameTimes(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, time] of a) if (b.get(file) !== time) return false;
  return true;
}

export class BuildWatch {
  private dir: string;
  /** 起動したときの中身。動いているのはこれ */
  private start: Snapshot | null;
  /** 最後に見た日時。変わっていなければ中身を読み直さない */
  private lastTimes: Map<string, number> | null;
  private known = false;

  constructor(dir: string) {
    this.dir = dir;
    try {
      this.start = snapshot(dir);
      this.lastTimes = this.start.times;
    } catch {
      // 読めない場所（パッケージ版の中など）。何も言わない
      this.start = null;
      this.lastTimes = null;
    }
  }

  /**
   * 起動したときから、ビルドの中身が変わったか。
   *
   * **一度変わったと分かったら、そのまま true。** 元に戻されても、動いているのは
   * 起動時の中身で、戻した後のものとは限らない（確かめるより再起動が早い）
   */
  stale(): boolean {
    if (this.known) return true;
    if (!this.start) return false;

    let times: Map<string, number>;
    try {
      times = new Map(listJs(this.dir).map((file) => [file, fs.statSync(file).mtimeMs]));
    } catch {
      return false; // ビルドの途中で消えている等。次に見る
    }
    if (this.lastTimes && sameTimes(times, this.lastTimes)) return false;

    let now: Snapshot;
    try {
      now = snapshot(this.dir);
    } catch {
      return false;
    }
    this.lastTimes = now.times;
    if (now.digest !== this.start.digest) this.known = true;
    return this.known;
  }
}

/**
 * node-pty の代わりに SessionManager へ注入するフェイク。
 *
 * 実プロセスを起動せずに write / resize / kill / データ受信を検証できる。
 */

import type { Pty, PtyFactoryOptions } from "../../../types/panedeck";

export interface FakePty extends Pty {
  options: PtyFactoryOptions;
  written: string[];
  resized: Array<{ cols: number; rows: number }>;
  killed: boolean;

  // --- テストから呼ぶ操作 ---
  emitData(data: string): void;
  emitExit(exitCode?: number): void;
}

export function createFakePty(options: PtyFactoryOptions): FakePty {
  const dataHandlers: Array<(data: string) => void> = [];
  const exitHandlers: Array<(event: { exitCode: number }) => void> = [];

  const pty: FakePty = {
    options,
    written: [],
    resized: [],
    killed: false,

    write(data) {
      pty.written.push(data);
    },
    resize(cols, rows) {
      pty.resized.push({ cols, rows });
    },
    kill() {
      pty.killed = true;
    },
    onData(cb) {
      dataHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },

    emitData(data) {
      dataHandlers.forEach((cb) => cb(data));
    },
    emitExit(exitCode = 0) {
      exitHandlers.forEach((cb) => cb({ exitCode }));
    },
  };

  return pty;
}

export interface FakePtyFactory {
  (options: PtyFactoryOptions): FakePty;
  created: FakePty[];
  last(): FakePty;
}

/** 生成された pty を記録するファクトリを返す。 */
export function createFakePtyFactory(): FakePtyFactory {
  const created: FakePty[] = [];
  const factory = ((options: PtyFactoryOptions) => {
    const pty = createFakePty(options);
    created.push(pty);
    return pty;
  }) as FakePtyFactory;

  factory.created = created;
  factory.last = () => created[created.length - 1];
  return factory;
}

export interface FakeClock {
  (): number;
  advance(ms: number): void;
}

/** テストから進められる時計。 */
export function createFakeClock(start = 1000): FakeClock {
  let current = start;
  const now = (() => current) as FakeClock;
  now.advance = (ms: number) => {
    current += ms;
  };
  return now;
}

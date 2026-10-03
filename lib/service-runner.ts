/**
 * 裏で走らせ続けるコマンド（#29）。
 *
 * ペインではなく PaneDeck 自身が抱える。落ちたら起こし直し、出力はログとして
 * 見られるようにする。
 *
 * **出力をペインへ直接流さない。** コマンドの仕事はファイルへ書くことで、
 * ペインへ伝えるのはファイルを見ているトリガー（#28）。間にファイルを挟むから、
 * 受け取ってから伝えるまでに PaneDeck が止まっても行は残る。直接流していたら、
 * まさにその行が失われる。
 *
 * 子プロセスの起動も時刻も注入する。実プロセスも実時間も使わずに
 * 「いつ起こし直すか」を確かめられる。起こし直しはタイマーではなく `tick()` で
 * 判断する —— 時計を差し替えるだけで決定的に試せる。
 */

export interface ServiceConfig {
  /** 画面に出す名前。ログの宛先でもある */
  name: string;
  command: string;
  /** 既定は always。never なら終わったらそのまま */
  restart?: "always" | "never";
}

export interface ServiceProcess {
  onStdout(cb: (text: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export type ServiceStatus = "running" | "restarting" | "stopped";

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  /** 続けて落ちた回数。走り続けられたら 0 に戻る */
  restarts: number;
  lastExitCode: number | null;
}

export interface ServiceRunnerDeps {
  spawn: (command: string) => ServiceProcess;
  now?: () => number;
  /** ログとして持つ最大文字数 */
  maxLogChars?: number;
}

/**
 * 落ちてから起こし直すまでの待ち時間 (ms)。
 *
 * 即死するコマンドで回り続けないため。延び方は決め打ちで、**上限を持つ**
 * （延び続けると、直ったのに何分も起きてこない）。
 */
export const BACKOFF_STEPS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * これだけ走れたら「ちゃんと動いていた」とみなし、失敗の数を忘れる。
 *
 * 一度安定した後の 1 回の終了で、待ち時間が最大のままになるのを避ける。
 */
const STABLE_MS = 30_000;

const DEFAULT_MAX_LOG_CHARS = 50_000;

interface Entry {
  config: ServiceConfig;
  process: ServiceProcess | null;
  status: ServiceStatus;
  restarts: number;
  lastExitCode: number | null;
  startedAt: number;
  /** この時刻を過ぎたら起こし直す。null なら予定なし */
  restartAt: number | null;
  log: string;
}

export class ServiceRunner {
  private entries = new Map<string, Entry>();
  private spawn: (command: string) => ServiceProcess;
  private now: () => number;
  private maxLogChars: number;
  private stopped = false;

  constructor({ spawn, now = () => Date.now(), maxLogChars }: ServiceRunnerDeps) {
    this.spawn = spawn;
    this.now = now;
    this.maxLogChars = maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
  }

  start(configs: ServiceConfig[]): void {
    this.stopped = false;
    for (const config of configs) {
      const entry: Entry = {
        config,
        process: null,
        status: "stopped",
        restarts: 0,
        lastExitCode: null,
        startedAt: 0,
        restartAt: null,
        log: "",
      };
      this.entries.set(config.name, entry);
      this.launch(entry);
    }
  }

  /** 起こし直す時刻を過ぎたものを起こす。外から定期的に呼ぶ。 */
  tick(): void {
    if (this.stopped) return;
    for (const entry of this.entries.values()) {
      if (entry.restartAt === null) continue;
      if (this.now() < entry.restartAt) continue;
      entry.restartAt = null;
      this.launch(entry);
    }
  }

  state(): ServiceState[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.config.name,
      status: entry.status,
      restarts: entry.restarts,
      lastExitCode: entry.lastExitCode,
    }));
  }

  log(name: string): string {
    return this.entries.get(name)?.log ?? "";
  }

  /** 全部殺す。**以後は終了が届いても起こし直さない。** */
  stopAll(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      entry.restartAt = null;
      entry.status = "stopped";
      entry.process?.kill();
      entry.process = null;
    }
  }

  private launch(entry: Entry): void {
    const proc = this.spawn(entry.config.command);
    entry.process = proc;
    entry.status = "running";
    entry.startedAt = this.now();

    proc.onStdout((text) => this.append(entry, text));
    proc.onStderr((text) => this.append(entry, text));
    proc.onExit((code) => this.handleExit(entry, code));
  }

  private handleExit(entry: Entry, code: number): void {
    entry.process = null;
    entry.lastExitCode = code;

    if (this.stopped || entry.config.restart === "never") {
      entry.status = "stopped";
      return;
    }

    // 走り続けられたなら、その前の失敗は数えない
    if (this.now() - entry.startedAt >= STABLE_MS) entry.restarts = 0;

    const wait = BACKOFF_STEPS[Math.min(entry.restarts, BACKOFF_STEPS.length - 1)];
    entry.restarts += 1;
    entry.status = "restarting";
    entry.restartAt = this.now() + wait;
  }

  private append(entry: Entry, text: string): void {
    const next = entry.log + text;
    entry.log =
      next.length > this.maxLogChars ? next.slice(next.length - this.maxLogChars) : next;
  }
}

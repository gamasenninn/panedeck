import { test, expect } from "@playwright/test";
import { ServiceRunner, BACKOFF_STEPS } from "../../lib/service-runner";

/**
 * 裏で走らせ続けるコマンド（#29）。
 *
 * ペインではなく PaneDeck 自身が抱える。落ちたら起こし直し、出力はログとして
 * 見られるようにする。**出力をペインへ直接流さない**のが肝で、受け取ってから
 * 伝えるまでの間に PaneDeck が止まっても、ファイルに残っていれば失われない。
 *
 * 子プロセスの起動も時刻も注入する。実プロセスも実時間も使わずに
 * 「いつ起こし直すか」を確かめられる。
 */

function createFakeSpawner() {
  const spawned: Array<{
    command: string;
    killed: boolean;
    emitOut(text: string): void;
    emitErr(text: string): void;
    emitExit(code: number): void;
  }> = [];

  const spawn = (command: string) => {
    const outs: Array<(t: string) => void> = [];
    const errs: Array<(t: string) => void> = [];
    const exits: Array<(c: number) => void> = [];
    const proc = {
      command,
      killed: false,
      onStdout: (cb: (t: string) => void) => outs.push(cb),
      onStderr: (cb: (t: string) => void) => errs.push(cb),
      onExit: (cb: (c: number) => void) => exits.push(cb),
      kill: () => {
        proc.killed = true;
      },
      emitOut: (t: string) => outs.forEach((cb) => cb(t)),
      emitErr: (t: string) => errs.forEach((cb) => cb(t)),
      emitExit: (c: number) => exits.forEach((cb) => cb(c)),
    };
    spawned.push(proc);
    return proc;
  };

  return Object.assign(spawn, { spawned });
}

function setup() {
  const spawn = createFakeSpawner();
  let clock = 1000;
  const runner = new ServiceRunner({ spawn, now: () => clock });
  return {
    runner,
    spawn,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const SERVICE = { name: "feed", command: "node stream.js" };

test.describe("起動", () => {
  test("設定したコマンドを起こす", () => {
    const { runner, spawn } = setup();
    runner.start([SERVICE]);

    expect(spawn.spawned).toHaveLength(1);
    expect(spawn.spawned[0].command).toBe("node stream.js");
    expect(runner.state()[0].status).toBe("running");
  });

  test("設定が空なら何も起こさない", () => {
    const { runner, spawn } = setup();
    runner.start([]);
    expect(spawn.spawned).toHaveLength(0);
  });
});

test.describe("落ちたら起こし直す", () => {
  test("終了したら待ってから起こし直す", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    spawn.spawned[0].emitExit(1);
    expect(runner.state()[0].status).toBe("restarting");

    // すぐには起こさない（即死するコマンドで回り続けないため）
    runner.tick();
    expect(spawn.spawned).toHaveLength(1);

    advance(BACKOFF_STEPS[0]);
    runner.tick();
    expect(spawn.spawned).toHaveLength(2);
    expect(runner.state()[0].status).toBe("running");
  });

  test("続けて落ちるほど待ち時間が延びる", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    for (let i = 0; i < 3; i++) {
      spawn.spawned[spawn.spawned.length - 1].emitExit(1);
      // 1 つ手前の待ち時間では起きない
      if (i > 0) {
        advance(BACKOFF_STEPS[i - 1]);
        runner.tick();
        expect(spawn.spawned).toHaveLength(i + 1);
      }
      advance(BACKOFF_STEPS[i]);
      runner.tick();
      expect(spawn.spawned).toHaveLength(i + 2);
    }
  });

  test("待ち時間には上限がある（永久に延び続けない）", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    for (let i = 0; i < BACKOFF_STEPS.length + 5; i++) {
      spawn.spawned[spawn.spawned.length - 1].emitExit(1);
      advance(BACKOFF_STEPS[BACKOFF_STEPS.length - 1]);
      runner.tick();
    }
    expect(runner.state()[0].status).toBe("running");
  });

  /** しばらく走れたなら、その前の失敗は数えない */
  test("長く走れたら待ち時間が戻る", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    spawn.spawned[0].emitExit(1);
    advance(BACKOFF_STEPS[0]);
    runner.tick();
    expect(runner.state()[0].restarts).toBe(1);

    // 2 本目は十分に走ってから落ちる
    advance(60_000);
    spawn.spawned[1].emitExit(0);
    advance(BACKOFF_STEPS[0]);
    runner.tick();

    expect(runner.state()[0].restarts).toBe(1);
    expect(spawn.spawned).toHaveLength(3);
  });

  test('restart が never なら起こし直さない', () => {
    const { runner, spawn, advance } = setup();
    runner.start([{ ...SERVICE, restart: "never" }]);

    spawn.spawned[0].emitExit(0);
    expect(runner.state()[0].status).toBe("stopped");

    advance(60_000);
    runner.tick();
    expect(spawn.spawned).toHaveLength(1);
  });
});

test.describe("見えること", () => {
  test("stdout も stderr もログに入る", () => {
    const { runner, spawn } = setup();
    runner.start([SERVICE]);

    spawn.spawned[0].emitOut("接続しました\n");
    spawn.spawned[0].emitErr("警告: 再接続します\n");

    expect(runner.log("feed")).toContain("接続しました");
    expect(runner.log("feed")).toContain("警告: 再接続します");
  });

  /** 落ち続けていることを隠さない */
  test("連続して落ちた回数が分かる", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    for (let i = 0; i < 3; i++) {
      spawn.spawned[spawn.spawned.length - 1].emitExit(1);
      advance(BACKOFF_STEPS[Math.min(i, BACKOFF_STEPS.length - 1)]);
      runner.tick();
    }
    expect(runner.state()[0].restarts).toBe(3);
  });

  test("終了コードが分かる", () => {
    const { runner, spawn } = setup();
    runner.start([SERVICE]);
    spawn.spawned[0].emitExit(127);

    expect(runner.state()[0].lastExitCode).toBe(127);
  });

  test("ログは際限なく溜めない", () => {
    const { runner, spawn } = setup();
    runner.start([SERVICE]);

    for (let i = 0; i < 2000; i++) spawn.spawned[0].emitOut(`行 ${i}\n`);

    expect(runner.log("feed").length).toBeLessThan(60_000);
    // 新しいほうが残る
    expect(runner.log("feed")).toContain("行 1999");
  });
});

test.describe("後始末", () => {
  test("止めたら子プロセスを殺す", () => {
    const { runner, spawn } = setup();
    runner.start([SERVICE, { name: "other", command: "node b.js" }]);

    runner.stopAll();

    expect(spawn.spawned.every((p) => p.killed)).toBe(true);
  });

  /** 止めた後に終了が届いても、起こし直してはいけない */
  test("止めた後は起こし直さない", () => {
    const { runner, spawn, advance } = setup();
    runner.start([SERVICE]);

    runner.stopAll();
    spawn.spawned[0].emitExit(0);
    advance(60_000);
    runner.tick();

    expect(spawn.spawned).toHaveLength(1);
  });
});

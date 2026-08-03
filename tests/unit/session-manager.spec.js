const { test, expect } = require("@playwright/test");
const { SessionManager } = require("../../lib/session-manager");
const { STATUS, QUIET_MS } = require("../../lib/status-detector");
const {
  createFakePtyFactory,
  createFakeClock,
} = require("./helpers/fake-pty");

function setup(options = {}) {
  const ptyFactory = createFakePtyFactory();
  const now = createFakeClock();
  const manager = new SessionManager({ ptyFactory, now, ...options });
  return { manager, ptyFactory, now };
}

test.describe("create", () => {
  test("セッションを生成して一覧に載せる", () => {
    const { manager } = setup();
    const session = manager.create({ cwd: "C:\\app\\repo-a", shell: "pwsh" });

    expect(session.id).toBeTruthy();
    expect(session.cwd).toBe("C:\\app\\repo-a");
    expect(session.shell).toBe("pwsh");
    expect(manager.list()).toHaveLength(1);
  });

  test("pty を cwd / shell / args 付きで生成する", () => {
    const { manager, ptyFactory } = setup();
    manager.create({
      cwd: "C:\\app\\repo-a",
      shell: "pwsh",
      args: ["-NoLogo"],
      cols: 100,
      rows: 40,
    });

    const opts = ptyFactory.last().options;
    expect(opts.shell).toBe("pwsh");
    expect(opts.args).toEqual(["-NoLogo"]);
    expect(opts.cwd).toBe("C:\\app\\repo-a");
    expect(opts.cols).toBe(100);
    expect(opts.rows).toBe(40);
  });

  test("複数生成しても id が重複しない", () => {
    const { manager } = setup();
    const ids = [1, 2, 3, 4, 5].map((i) => manager.create({ cwd: `dir${i}` }).id);
    expect(new Set(ids).size).toBe(5);
  });

  test("title 未指定なら cwd の末尾をタイトルにする", () => {
    const { manager } = setup();
    expect(manager.create({ cwd: "C:\\app\\repo-a" }).title).toBe("repo-a");
    expect(manager.create({ cwd: "/home/user/repo-b" }).title).toBe("repo-b");
  });

  test("title を明示したらそれを使う", () => {
    const { manager } = setup();
    expect(manager.create({ cwd: "C:\\app\\x", title: "本番" }).title).toBe("本番");
  });

  test("生成直後の状態は idle", () => {
    const { manager, now } = setup();
    const session = manager.create({ cwd: "x" });
    now.advance(QUIET_MS + 100);
    expect(manager.get(session.id).status).toBe(STATUS.IDLE);
  });
});

test.describe("get / list", () => {
  test("存在しない id には null を返す", () => {
    const { manager } = setup();
    expect(manager.get("no-such-id")).toBeNull();
  });

  test("list は生成順に返す", () => {
    const { manager } = setup();
    manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });
    manager.create({ cwd: "c" });
    expect(manager.list().map((s) => s.title)).toEqual(["a", "b", "c"]);
  });

  test("スナップショットに pty 本体を含めない（IPC で送れる形にする）", () => {
    const { manager } = setup();
    const session = manager.create({ cwd: "a" });
    expect(session.pty).toBeUndefined();
    expect(() => JSON.stringify(session)).not.toThrow();
  });
});

test.describe("write", () => {
  test("指定したセッションにだけ書き込む", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });

    expect(manager.write(a.id, "ls\r")).toBe(true);
    expect(ptyFactory.created[0].written).toEqual(["ls\r"]);
    expect(ptyFactory.created[1].written).toEqual([]);
  });

  test("存在しない id なら false を返す", () => {
    const { manager } = setup();
    expect(manager.write("nope", "x")).toBe(false);
  });

  test("終了済みセッションには書き込まない", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitExit(0);
    expect(manager.write(a.id, "x")).toBe(false);
  });

  test("空文字列も書き込める", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.write(a.id, "")).toBe(true);
    expect(ptyFactory.last().written).toEqual([""]);
  });
});

test.describe("broadcast", () => {
  test("ids 未指定なら全セッションに書き込む", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });
    manager.create({ cwd: "c" });

    expect(manager.broadcast("npm test\r")).toBe(3);
    ptyFactory.created.forEach((pty) => {
      expect(pty.written).toEqual(["npm test\r"]);
    });
  });

  test("ids を指定したらそのセッションだけに書き込む", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });
    const c = manager.create({ cwd: "c" });

    expect(manager.broadcast("hi", [a.id, c.id])).toBe(2);
    expect(ptyFactory.created[0].written).toEqual(["hi"]);
    expect(ptyFactory.created[1].written).toEqual([]);
    expect(ptyFactory.created[2].written).toEqual(["hi"]);
  });

  test("終了済みセッションは対象から外し、生きている分だけ数える", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });
    ptyFactory.created[0].emitExit(0);

    expect(manager.broadcast("hi")).toBe(1);
    expect(ptyFactory.created[0].written).toEqual([]);
    expect(ptyFactory.created[1].written).toEqual(["hi"]);
  });

  test("セッションが無ければ 0 を返す", () => {
    const { manager } = setup();
    expect(manager.broadcast("hi")).toBe(0);
  });

  test("存在しない id が混ざっていても落ちない", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.broadcast("hi", [a.id, "ghost"])).toBe(1);
  });
});

test.describe("resize", () => {
  test("対象セッションの pty をリサイズする", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.resize(a.id, 120, 50)).toBe(true);
    expect(ptyFactory.last().resized).toEqual([{ cols: 120, rows: 50 }]);
  });

  test("存在しない id なら false", () => {
    const { manager } = setup();
    expect(manager.resize("nope", 80, 24)).toBe(false);
  });
});

test.describe("close", () => {
  test("pty を kill して一覧から外す", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.close(a.id)).toBe(true);
    expect(ptyFactory.last().killed).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(manager.get(a.id)).toBeNull();
  });

  test("存在しない id なら false", () => {
    const { manager } = setup();
    expect(manager.close("nope")).toBe(false);
  });

  test("closeAll は全部閉じて件数を返す", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a" });
    manager.create({ cwd: "b" });

    expect(manager.closeAll()).toBe(2);
    expect(manager.list()).toHaveLength(0);
    ptyFactory.created.forEach((pty) => expect(pty.killed).toBe(true));
  });
});

test.describe("出力の受信", () => {
  test("onData に id 付きで通知する", () => {
    const { manager, ptyFactory } = setup();
    const received = [];
    manager.onData((id, data) => received.push({ id, data }));

    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitData("hello");

    expect(received).toEqual([{ id: a.id, data: "hello" }]);
  });

  test("onExit に id と終了コードを通知する", () => {
    const { manager, ptyFactory } = setup();
    const received = [];
    manager.onExit((id, code) => received.push({ id, code }));

    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitExit(3);

    expect(received).toEqual([{ id: a.id, code: 3 }]);
  });

  test("終了後もセッションは一覧に残り、状態が exited になる", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitExit(1);

    expect(manager.list()).toHaveLength(1);
    expect(manager.get(a.id).status).toBe(STATUS.EXITED);
    expect(manager.get(a.id).exitCode).toBe(1);
  });
});

test.describe("ログ", () => {
  test("受信した出力を蓄積する", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitData("foo");
    ptyFactory.last().emitData("bar");

    expect(manager.getLog(a.id)).toBe("foobar");
  });

  test("存在しない id のログは空文字列", () => {
    const { manager } = setup();
    expect(manager.getLog("nope")).toBe("");
  });

  test("maxLogBytes を超えたら先頭から捨てる", () => {
    const { manager, ptyFactory } = setup({ maxLogBytes: 10 });
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitData("0123456789ABCDE");

    const log = manager.getLog(a.id);
    expect(log).toHaveLength(10);
    expect(log).toBe("56789ABCDE");
  });

  test("セッションごとにログが独立している", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    const b = manager.create({ cwd: "b" });
    ptyFactory.created[0].emitData("AAA");
    ptyFactory.created[1].emitData("BBB");

    expect(manager.getLog(a.id)).toBe("AAA");
    expect(manager.getLog(b.id)).toBe("BBB");
  });
});

test.describe("状態の算出", () => {
  test("出力直後は running", () => {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a" });
    now.advance(5000);
    ptyFactory.last().emitData("building...");

    expect(manager.get(a.id).status).toBe(STATUS.RUNNING);
  });

  test("出力が止まって静止したら idle", () => {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitData("done");
    now.advance(QUIET_MS + 100);

    expect(manager.get(a.id).status).toBe(STATUS.IDLE);
  });

  test("Claude の入力ボックスで静止したら waiting", () => {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last().emitData("╭────╮\n│ >  │\n╰────╯");
    now.advance(QUIET_MS + 100);

    expect(manager.get(a.id).status).toBe(STATUS.WAITING);
  });

  test("list でも同じ状態が得られる", () => {
    const { manager, ptyFactory, now } = setup();
    manager.create({ cwd: "a" });
    ptyFactory.last().emitData("│ > ");
    now.advance(QUIET_MS + 100);

    expect(manager.list()[0].status).toBe(STATUS.WAITING);
  });
});

test.describe("起動コマンド (initialCommand)", () => {
  test("起動直後に pty へ改行付きで書き込む", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "claude" });

    expect(ptyFactory.last().written).toEqual(["claude\r"]);
  });

  test("未指定なら何も書き込まない", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a" });

    expect(ptyFactory.last().written).toEqual([]);
  });

  test("空文字列なら何も書き込まない（素のシェルのまま）", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "" });

    expect(ptyFactory.last().written).toEqual([]);
  });

  test("スナップショットに含まれる", () => {
    const { manager } = setup();
    const session = manager.create({ cwd: "a", initialCommand: "codex" });

    expect(session.initialCommand).toBe("codex");
    expect(manager.get(session.id).initialCommand).toBe("codex");
  });

  test("セッションごとに独立した値を持つ", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "claude" });
    manager.create({ cwd: "b", initialCommand: "codex --resume" });
    manager.create({ cwd: "c" });

    expect(ptyFactory.created[0].written).toEqual(["claude\r"]);
    expect(ptyFactory.created[1].written).toEqual(["codex --resume\r"]);
    expect(ptyFactory.created[2].written).toEqual([]);

    expect(manager.list().map((s) => s.initialCommand)).toEqual([
      "claude",
      "codex --resume",
      undefined,
    ]);
  });

  test("前後の空白は落とす", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "  claude  " });

    expect(ptyFactory.last().written).toEqual(["claude\r"]);
  });

  test("空白だけなら何も書き込まない", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "   " });

    expect(ptyFactory.last().written).toEqual([]);
  });
});

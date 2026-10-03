import { test, expect } from "@playwright/test";
import { SessionManager } from "../../lib/session-manager";
import { STATUS, QUIET_MS } from "../../lib/status-detector";
import { createFakePtyFactory, createFakeClock } from "./helpers/fake-pty";

function setup(options: Record<string, unknown> = {}) {
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

    const opts = ptyFactory.last()!.options;
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
    expect(manager.get(session.id)!.status).toBe(STATUS.IDLE);
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
    // 型の上では存在しない項目。実体に混ざっていないことを見る
    expect((session as any).pty).toBeUndefined();
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
    ptyFactory.last()!.emitExit(0);
    expect(manager.write(a.id, "x")).toBe(false);
  });

  test("空文字列も書き込める", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.write(a.id, "")).toBe(true);
    expect(ptyFactory.last()!.written).toEqual([""]);
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
    expect(ptyFactory.last()!.resized).toEqual([{ cols: 120, rows: 50 }]);
  });

  test("存在しない id なら false", () => {
    const { manager } = setup();
    expect(manager.resize("nope", 80, 24)).toBe(false);
  });

  test("終了済みセッションはリサイズしない", () => {
    // node-pty は終了済みの pty をリサイズすると例外を投げる。
    // レンダラは文字サイズ変更・列数変更・ウィンドウリサイズのたびに
    // 全ペインへ resize を投げるので、終了したペインが 1 つでも残っていると
    // メインプロセスで未処理例外になる（write と同じく状態を見る必要がある）
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitExit(0);

    expect(manager.resize(a.id, 120, 50)).toBe(false);
    expect(ptyFactory.last()!.resized).toEqual([]);
  });

  /**
   * Windows の ConPTY は起動直後のリサイズでメインプロセスごと固まることが
   * ある（#16）。画面側は起動時に 80x24 → 79x24 → 実寸と続けて投げてくるので、
   * 実際には何も変わらない要求をここで落として呼び出し回数を減らす。
   */
  test("同じ寸法への要求では pty を触らない", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a", cols: 80, rows: 24 });

    expect(manager.resize(a.id, 80, 24)).toBe(true);
    expect(ptyFactory.last()!.resized).toEqual([]);

    manager.resize(a.id, 100, 30);
    manager.resize(a.id, 100, 30);
    expect(ptyFactory.last()!.resized).toEqual([{ cols: 100, rows: 30 }]);
  });

  /**
   * ConPTY は子プロセスが消えた後にリサイズすると戻ってこない。node-pty の
   * onExit は実際の終了より遅れて届くので、exited フラグだけでは
   * 「もう居ないのに exited はまだ false」という隙間を塞げない（#16）。
   */
  test("プロセスが消えていたらリサイズしない", () => {
    const ptyFactory = createFakePtyFactory();
    const manager = new SessionManager({
      ptyFactory,
      now: createFakeClock(),
      isProcessAlive: () => false,
    });
    const a = manager.create({ cwd: "a", cols: 80, rows: 24 });
    (ptyFactory.last() as any).pid = 4242;

    expect(manager.resize(a.id, 100, 30)).toBe(false);
    expect(ptyFactory.last()!.resized).toEqual([]);
  });

  test("プロセスが生きていればリサイズする", () => {
    const ptyFactory = createFakePtyFactory();
    const manager = new SessionManager({
      ptyFactory,
      now: createFakeClock(),
      isProcessAlive: () => true,
    });
    const a = manager.create({ cwd: "a", cols: 80, rows: 24 });
    (ptyFactory.last() as any).pid = 4242;

    expect(manager.resize(a.id, 100, 30)).toBe(true);
    expect(ptyFactory.last()!.resized).toEqual([{ cols: 100, rows: 30 }]);
  });

  test("pid を持たない pty は生存確認を省く", () => {
    // フェイク pty には pid が無い。確認しようがないものを死んだ扱いにすると
    // 何もリサイズできなくなる
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a", cols: 80, rows: 24 });

    expect(manager.resize(a.id, 100, 30)).toBe(true);
    expect(ptyFactory.last()!.resized).toEqual([{ cols: 100, rows: 30 }]);
  });

  test("リサイズ後の寸法はセッションに反映される", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "a", cols: 80, rows: 24 });
    manager.resize(a.id, 100, 30);

    const session = manager.get(a.id)!;
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
  });
});

test.describe("close", () => {
  test("pty を kill して一覧から外す", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    expect(manager.close(a.id)).toBe(true);
    expect(ptyFactory.last()!.killed).toBe(true);
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
    const received: Array<{ id: string; data: string }> = [];
    manager.onData((id, data) => received.push({ id, data }));

    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("hello");

    expect(received).toEqual([{ id: a.id, data: "hello" }]);
  });

  test("onExit に id と終了コードを通知する", () => {
    const { manager, ptyFactory } = setup();
    const received: Array<{ id: string; code: number }> = [];
    manager.onExit((id, code) => received.push({ id, code }));

    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitExit(3);

    expect(received).toEqual([{ id: a.id, code: 3 }]);
  });

  test("終了後もセッションは一覧に残り、状態が exited になる", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitExit(1);

    expect(manager.list()).toHaveLength(1);
    expect(manager.get(a.id)!.status).toBe(STATUS.EXITED);
    expect(manager.get(a.id)!.exitCode).toBe(1);
  });
});

test.describe("ログ", () => {
  test("受信した出力を蓄積する", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("foo");
    ptyFactory.last()!.emitData("bar");

    expect(manager.getLog(a.id)).toBe("foobar");
  });

  test("存在しない id のログは空文字列", () => {
    const { manager } = setup();
    expect(manager.getLog("nope")).toBe("");
  });

  test("maxLogBytes を超えたら先頭から捨てる", () => {
    const { manager, ptyFactory } = setup({ maxLogBytes: 10 });
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("0123456789ABCDE");

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
    ptyFactory.last()!.emitData("building...");

    expect(manager.get(a.id)!.status).toBe(STATUS.RUNNING);
  });

  test("出力が止まって静止したら idle", () => {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("done");
    now.advance(QUIET_MS + 100);

    expect(manager.get(a.id)!.status).toBe(STATUS.IDLE);
  });

  test("Claude の入力ボックスで静止したら waiting", () => {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("╭────╮\n│ >  │\n╰────╯");
    now.advance(QUIET_MS + 100);

    expect(manager.get(a.id)!.status).toBe(STATUS.WAITING);
  });

  test("list でも同じ状態が得られる", () => {
    const { manager, ptyFactory, now } = setup();
    manager.create({ cwd: "a" });
    ptyFactory.last()!.emitData("│ > ");
    now.advance(QUIET_MS + 100);

    expect(manager.list()[0].status).toBe(STATUS.WAITING);
  });
});

test.describe("並べ替え", () => {
  function setupThree() {
    const { manager, ptyFactory, now } = setup();
    const a = manager.create({ cwd: "a", title: "A" });
    const b = manager.create({ cwd: "b", title: "B" });
    const c = manager.create({ cwd: "c", title: "C" });
    return { manager, ptyFactory, now, a, b, c };
  }

  const titles = (manager: SessionManager) => manager.list().map((s) => s.title);

  test("指定した順に並べ替える", () => {
    const { manager, a, b, c } = setupThree();
    manager.reorder([c.id, a.id, b.id]);

    expect(titles(manager)).toEqual(["C", "A", "B"]);
  });

  test("含まれない id は末尾に残る（相対順は保つ）", () => {
    // 並べ替え中にセッションが増えても、そのぶんが消えない
    const { manager, a, c } = setupThree();
    manager.reorder([c.id, a.id]);

    expect(titles(manager)).toEqual(["C", "A", "B"]);
  });

  test("存在しない id は無視する", () => {
    const { manager, a, b, c } = setupThree();
    manager.reorder([c.id, "nonexistent", a.id, b.id]);

    expect(titles(manager)).toEqual(["C", "A", "B"]);
  });

  test("重複した id は最初の 1 つだけ使う", () => {
    const { manager, a, b, c } = setupThree();
    manager.reorder([c.id, c.id, a.id, b.id]);

    expect(titles(manager)).toEqual(["C", "A", "B"]);
  });

  test("空配列なら並びは変わらない", () => {
    const { manager } = setupThree();
    manager.reorder([]);

    expect(titles(manager)).toEqual(["A", "B", "C"]);
  });

  test("引数が配列でなくても落ちない", () => {
    const { manager } = setupThree();
    expect(() => manager.reorder("nope" as any)).not.toThrow();
    expect(titles(manager)).toEqual(["A", "B", "C"]);
  });

  test("並べ替えてもセッションの中身は保たれる", () => {
    // ペインを作り直さずに並べ替えたいので、pty もログも同じものが残る必要がある
    const { manager, ptyFactory, a, b, c } = setupThree();
    ptyFactory.created[0].emitData("AAA");
    const ptyBefore = manager.sessions.get(a.id)!.pty;

    manager.reorder([c.id, b.id, a.id]);

    expect(manager.getLog(a.id)).toBe("AAA");
    expect(manager.sessions.get(a.id)!.pty).toBe(ptyBefore);
    expect(manager.write(a.id, "x")).toBe(true);
  });

  test("並べ替えた順で書き込み対象が決まる", () => {
    const { manager, ptyFactory, a, b, c } = setupThree();
    manager.reorder([c.id, b.id, a.id]);
    manager.broadcast("hello");

    // pty の生成順は変わらないので、中身で対応を確かめる
    expect(ptyFactory.created.every((p) => p.written.includes("hello"))).toBe(true);
  });

  test("並べ替えた順がワークスペースの並びになる", () => {
    const { manager, a, b, c } = setupThree();
    manager.reorder([b.id, c.id, a.id]);

    expect(manager.list().map((s) => s.cwd)).toEqual(["b", "c", "a"]);
  });
});

test.describe("エージェントプロファイル", () => {
  test("指定した agent がスナップショットに載る", () => {
    const { manager } = setup();
    const session = manager.create({ cwd: "a", agent: "codex" });

    expect(session.agent).toBe("codex");
    expect(manager.get(session.id)!.agent).toBe("codex");
  });

  test("未指定なら既定の claude になる（現行動作の維持）", () => {
    const { manager } = setup();
    expect(manager.create({ cwd: "a" }).agent).toBe("claude");
  });

  test("未知の agent は既定へ正規化される", () => {
    const { manager } = setup();
    expect(manager.create({ cwd: "a", agent: "nonexistent" }).agent).toBe("claude");
  });

  test("エージェントごとに異なるパターンで判定される", () => {
    const { manager, ptyFactory, now } = setup();
    const claude = manager.create({ cwd: "a", agent: "claude" });
    const codex = manager.create({ cwd: "b", agent: "codex" });

    // Claude Code の入力ボックスは claude のプロファイルでだけ入力待ちになる
    ptyFactory.created[0].emitData("│ > ");
    ptyFactory.created[1].emitData("│ > ");
    now.advance(QUIET_MS + 100);

    expect(manager.get(claude.id)!.status).toBe(STATUS.WAITING);
    expect(manager.get(codex.id)!.status).toBe(STATUS.IDLE);
  });

  /**
   * 確認プロンプトはどのエージェントでも拾う。ただし #27 以降、見分けられる
   * claude は asking まで言い切り、入力欄と選択肢が同じ `›` で出る codex は
   * 分割できないので従来の waiting に留まる。
   */
  test("共通の確認プロンプトはどのエージェントでも拾う", () => {
    const { manager, ptyFactory, now } = setup();
    const claude = manager.create({ cwd: "a", agent: "claude" });
    const codex = manager.create({ cwd: "b", agent: "codex" });

    ptyFactory.created[0].emitData("Continue? (y/n)");
    ptyFactory.created[1].emitData("Continue? (y/n)");
    now.advance(QUIET_MS + 100);

    expect(manager.get(claude.id)!.status).toBe(STATUS.ASKING);
    expect(manager.get(codex.id)!.status).toBe(STATUS.WAITING);
  });

  test("未知の agent でも既定のパターンで判定できる", () => {
    const { manager, ptyFactory, now } = setup();
    const session = manager.create({ cwd: "a", agent: "nonexistent" });
    ptyFactory.last()!.emitData("│ > ");
    now.advance(QUIET_MS + 100);

    expect(manager.get(session.id)!.status).toBe(STATUS.WAITING);
  });
});

test.describe("状態で絞った一斉送信", () => {
  /**
   * 4 つの状態がそろったデッキを作る。
   *
   * 状態は「最後の出力からの経過時間」で決まるので、まとめて出力させてから
   * 時計を進め、running にしたいものだけ進めた後に出力させる。
   */
  function setupDeck() {
    const { manager, ptyFactory, now } = setup();
    const waiting = manager.create({ cwd: "waiting" });
    const idle = manager.create({ cwd: "idle" });
    const running = manager.create({ cwd: "running" });
    const exited = manager.create({ cwd: "exited" });

    ptyFactory.created[0].emitData("│ > ");
    ptyFactory.created[1].emitData("Done.");
    ptyFactory.created[3].emitData("bye");
    now.advance(QUIET_MS + 100);

    ptyFactory.created[2].emitData("building...");
    ptyFactory.created[3].emitExit(0);

    return { manager, ptyFactory, now, waiting, idle, running, exited };
  }

  test("前提: 4 つの状態がそろっている", () => {
    const { manager } = setupDeck();
    expect(manager.list().map((s) => s.status)).toEqual([
      STATUS.WAITING,
      STATUS.IDLE,
      STATUS.RUNNING,
      STATUS.EXITED,
    ]);
  });

  test("入力待ちのセッションにだけ書き込む", () => {
    const { manager, ptyFactory } = setupDeck();
    manager.broadcast("go\r", undefined, { onlyStatus: STATUS.WAITING });

    expect(ptyFactory.created[0].written).toEqual(["go\r"]);
    expect(ptyFactory.created[1].written).toEqual([]);
    expect(ptyFactory.created[2].written).toEqual([]);
    expect(ptyFactory.created[3].written).toEqual([]);
  });

  test("書き込めた数を返す", () => {
    const { manager } = setupDeck();
    expect(manager.broadcast("go\r", undefined, { onlyStatus: STATUS.WAITING })).toBe(1);
  });

  test("該当が無ければ 0 を返し、誰にも書き込まない", () => {
    const { manager, ptyFactory } = setupDeck();
    // 入力待ちのセッションを閉じてから送る
    manager.close(manager.list()[0].id);

    expect(manager.broadcast("go\r", undefined, { onlyStatus: STATUS.WAITING })).toBe(0);
    expect(ptyFactory.created.every((p) => p.written.length === 0)).toBe(true);
  });

  test("ids と併用すると「ids のうち入力待ち」だけに送る", () => {
    const { manager, ptyFactory, waiting, idle } = setupDeck();
    manager.broadcast("go\r", [idle.id], { onlyStatus: STATUS.WAITING });
    expect(ptyFactory.created[0].written).toEqual([]);
    expect(ptyFactory.created[1].written).toEqual([]);

    manager.broadcast("go\r", [waiting.id, idle.id], { onlyStatus: STATUS.WAITING });
    expect(ptyFactory.created[0].written).toEqual(["go\r"]);
    expect(ptyFactory.created[1].written).toEqual([]);
  });

  test("他の状態でも絞れる", () => {
    const { manager, ptyFactory } = setupDeck();
    manager.broadcast("x", undefined, { onlyStatus: STATUS.IDLE });
    expect(ptyFactory.created[1].written).toEqual(["x"]);
    expect(ptyFactory.created[0].written).toEqual([]);
  });

  test("onlyStatus 未指定なら従来どおり全セッションへ送る", () => {
    const { manager, ptyFactory } = setupDeck();
    // 終了済みは元から書き込めないので 3
    expect(manager.broadcast("all\r")).toBe(3);
    expect(ptyFactory.created[0].written).toEqual(["all\r"]);
    expect(ptyFactory.created[1].written).toEqual(["all\r"]);
    expect(ptyFactory.created[2].written).toEqual(["all\r"]);
    expect(ptyFactory.created[3].written).toEqual([]);
  });

  test("未知の状態を渡したら誰にも送らない", () => {
    const { manager, ptyFactory } = setupDeck();
    const bogus = { onlyStatus: "nonsense" } as any;
    expect(manager.broadcast("x", undefined, bogus)).toBe(0);
    expect(ptyFactory.created.every((p) => p.written.length === 0)).toBe(true);
  });

  test("終了済みは exited で絞っても書き込めない", () => {
    const { manager, ptyFactory } = setupDeck();
    expect(manager.broadcast("x", undefined, { onlyStatus: STATUS.EXITED })).toBe(0);
    expect(ptyFactory.created[3].written).toEqual([]);
  });
});

test.describe("起動コマンド (initialCommand)", () => {
  test("起動直後に pty へ改行付きで書き込む", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "claude" });

    expect(ptyFactory.last()!.written).toEqual(["claude\r"]);
  });

  test("未指定なら何も書き込まない", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a" });

    expect(ptyFactory.last()!.written).toEqual([]);
  });

  test("空文字列なら何も書き込まない（素のシェルのまま）", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "" });

    expect(ptyFactory.last()!.written).toEqual([]);
  });

  test("スナップショットに含まれる", () => {
    const { manager } = setup();
    const session = manager.create({ cwd: "a", initialCommand: "codex" });

    expect(session.initialCommand).toBe("codex");
    expect(manager.get(session.id)!.initialCommand).toBe("codex");
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

    expect(ptyFactory.last()!.written).toEqual(["claude\r"]);
  });

  test("空白だけなら何も書き込まない", () => {
    const { manager, ptyFactory } = setup();
    manager.create({ cwd: "a", initialCommand: "   " });

    expect(ptyFactory.last()!.written).toEqual([]);
  });
});

/**
 * 状態の絞り込みは複数を受け取れる（#27）。
 *
 * テキストは「指示待ち」だけに送りたいが、Enter / ↑ / ↓ は「指示待ち」と
 * 「確認待ち」の両方へ届かせたい。分割できないプロファイルの「入力待ち」も
 * キー送信の対象には残す必要がある。
 */
test.describe("broadcast - 複数の状態で絞る", () => {
  function deck() {
    const { manager, ptyFactory, now } = setup();
    const ready = manager.create({ cwd: "ready" });
    const asking = manager.create({ cwd: "asking" });
    const idle = manager.create({ cwd: "idle" });

    // 出力を与えてから静止させ、状態を作る
    ptyFactory.created[0].emitData("⏸ manual mode on · ? for shortcuts");
    ptyFactory.created[1].emitData("Do you want to create note.txt?");
    ptyFactory.created[2].emitData("Done.");
    now.advance(QUIET_MS + 100);

    return { manager, ptyFactory, ids: { ready: ready.id, asking: asking.id, idle: idle.id } };
  }

  test("状態を 1 つ渡すと従来どおり絞る", () => {
    const { manager, ptyFactory } = deck();
    expect(manager.broadcast("hi", null, { onlyStatus: STATUS.READY })).toBe(1);
    expect(ptyFactory.created[0].written).toEqual(["hi"]);
    expect(ptyFactory.created[1].written).toEqual([]);
  });

  test("配列で渡すとそのいずれかに当てはまるものへ送る", () => {
    const { manager, ptyFactory } = deck();
    expect(
      manager.broadcast("\r", null, { onlyStatus: [STATUS.READY, STATUS.ASKING] })
    ).toBe(2);
    expect(ptyFactory.created[0].written).toEqual(["\r"]);
    expect(ptyFactory.created[1].written).toEqual(["\r"]);
    expect(ptyFactory.created[2].written).toEqual([]);
  });

  test("空配列はどこにも送らない（「絞らない」とは区別する）", () => {
    const { manager, ptyFactory } = deck();
    expect(manager.broadcast("hi", null, { onlyStatus: [] })).toBe(0);
    expect(ptyFactory.created[0].written).toEqual([]);
  });
});

/**
 * ペインに自分の題を付ける（#28）。
 *
 * トリガーの送り先は題で指す。既定の題は作業ディレクトリの末尾なので、
 * **同じディレクトリで役割の違う 2 枚**を開くと衝突する。付け替えられないと
 * 送り先を一意に指せない。
 */
test.describe("rename", () => {
  test("題を付け替える", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "/work/repo-a" });
    expect(manager.get(a.id)!.title).toBe("repo-a");

    expect(manager.rename(a.id, "レビュー係")).toBe(true);
    expect(manager.get(a.id)!.title).toBe("レビュー係");
  });

  test("存在しない id なら false", () => {
    const { manager } = setup();
    expect(manager.rename("nope", "x")).toBe(false);
  });

  /** 題が無いペインは送り先として指せない。既定へ戻す */
  test("空にしたら作業ディレクトリ由来の既定へ戻す", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "/work/repo-a", title: "いったん別名" });

    expect(manager.rename(a.id, "   ")).toBe(true);
    expect(manager.get(a.id)!.title).toBe("repo-a");
  });

  test("前後の空白は落とす", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "a" });
    manager.rename(a.id, "  係  ");
    expect(manager.get(a.id)!.title).toBe("係");
  });

  /** 題は 1 行でなければならない。改行が入ると表示も一致判定も壊れる */
  test("改行や制御文字は空白に均す", () => {
    const { manager } = setup();
    const a = manager.create({ cwd: "a" });
    manager.rename(a.id, "前\n後");
    expect(manager.get(a.id)!.title).toBe("前 後");
  });

  test("終了済みのセッションでも題は変えられる", () => {
    const { manager, ptyFactory } = setup();
    const a = manager.create({ cwd: "a" });
    ptyFactory.last()!.emitExit(0);

    expect(manager.rename(a.id, "終わった係")).toBe(true);
    expect(manager.get(a.id)!.title).toBe("終わった係");
  });
});

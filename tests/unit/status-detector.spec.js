const { test, expect } = require("@playwright/test");
const {
  detectStatus,
  stripAnsi,
  lastNonEmptyLine,
  STATUS,
  QUIET_MS,
} = require("../../lib/status-detector");

test.describe("stripAnsi", () => {
  test("色指定のエスケープシーケンスを除去する", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("カーソル移動・画面消去シーケンスを除去する", () => {
    expect(stripAnsi("\x1b[2J\x1b[HHello\x1b[K")).toBe("Hello");
  });

  test("プレーンテキストはそのまま返す", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  test("空文字列を扱える", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("null / undefined は空文字列にする", () => {
    expect(stripAnsi(null)).toBe("");
    expect(stripAnsi(undefined)).toBe("");
  });
});

test.describe("lastNonEmptyLine", () => {
  test("末尾の空行を飛ばして最後の中身のある行を返す", () => {
    expect(lastNonEmptyLine("a\nb\n\n\n")).toBe("b");
  });

  test("行末の空白を落とす", () => {
    expect(lastNonEmptyLine("PS C:\\app>   ")).toBe("PS C:\\app>");
  });

  test("すべて空なら空文字列を返す", () => {
    expect(lastNonEmptyLine("\n\n  \n")).toBe("");
  });

  test("CRLF 改行を扱える", () => {
    expect(lastNonEmptyLine("first\r\nsecond\r\n")).toBe("second");
  });
});

test.describe("detectStatus - 終了判定", () => {
  test("exited が true なら常に exited", () => {
    const status = detectStatus({
      tail: "PS C:\\app>",
      msSinceLastOutput: 9999,
      exited: true,
      exitCode: 0,
    });
    expect(status).toBe(STATUS.EXITED);
  });

  test("出力が流れていても exited が優先される", () => {
    const status = detectStatus({
      tail: "building...",
      msSinceLastOutput: 0,
      exited: true,
      exitCode: 1,
    });
    expect(status).toBe(STATUS.EXITED);
  });
});

test.describe("detectStatus - 実行中判定", () => {
  test("直近に出力があれば running", () => {
    const status = detectStatus({
      tail: "compiling module 3/10",
      msSinceLastOutput: 50,
      exited: false,
    });
    expect(status).toBe(STATUS.RUNNING);
  });

  test("静止時間が QUIET_MS 未満なら running", () => {
    const status = detectStatus({
      tail: "anything",
      msSinceLastOutput: QUIET_MS - 1,
      exited: false,
    });
    expect(status).toBe(STATUS.RUNNING);
  });

  test("入力待ちパターンでも出力が動いていれば running", () => {
    const status = detectStatus({
      tail: "│ > ",
      msSinceLastOutput: 10,
      exited: false,
    });
    expect(status).toBe(STATUS.RUNNING);
  });

  test("quietMs をオプションで上書きできる", () => {
    const status = detectStatus({
      tail: "PS C:\\app>",
      msSinceLastOutput: 100,
      exited: false,
      quietMs: 1000,
    });
    expect(status).toBe(STATUS.RUNNING);
  });
});

test.describe("detectStatus - 入力待ち判定", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100, exited: false };

  test("Claude Code の入力ボックスを waiting と判定する", () => {
    const tail = [
      "╭──────────────────────────────────────╮",
      "│ >                                    │",
      "╰──────────────────────────────────────╯",
    ].join("\n");
    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.WAITING);
  });

  test("選択肢プロンプト(❯)を waiting と判定する", () => {
    const tail = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.WAITING);
  });

  test("(y/n) 確認を waiting と判定する", () => {
    expect(detectStatus({ ...quiet, tail: "Overwrite file? (y/n)" })).toBe(
      STATUS.WAITING
    );
  });

  test("[Y/n] 形式も waiting と判定する", () => {
    expect(detectStatus({ ...quiet, tail: "Continue? [Y/n]" })).toBe(
      STATUS.WAITING
    );
  });

  test("Press Enter を waiting と判定する", () => {
    expect(detectStatus({ ...quiet, tail: "Press Enter to continue" })).toBe(
      STATUS.WAITING
    );
  });

  test("ANSI 色付きの入力ボックスでも waiting と判定する", () => {
    const tail = "\x1b[36m│\x1b[0m \x1b[1m>\x1b[0m  ";
    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.WAITING);
  });
});

test.describe("detectStatus - アイドル判定", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100, exited: false };

  test("PowerShell プロンプトは idle", () => {
    expect(detectStatus({ ...quiet, tail: "PS C:\\app\\panedeck>" })).toBe(
      STATUS.IDLE
    );
  });

  test("bash プロンプトは idle", () => {
    expect(detectStatus({ ...quiet, tail: "user@host:~/work$" })).toBe(
      STATUS.IDLE
    );
  });

  test("root プロンプト(#)は idle", () => {
    expect(detectStatus({ ...quiet, tail: "root@box:/#" })).toBe(STATUS.IDLE);
  });

  test("空の出力は idle", () => {
    expect(detectStatus({ ...quiet, tail: "" })).toBe(STATUS.IDLE);
  });

  test("tail が未指定でも落ちずに idle を返す", () => {
    expect(detectStatus({ msSinceLastOutput: 9999, exited: false })).toBe(
      STATUS.IDLE
    );
  });

  test("プロンプトでも入力待ちでもない静止出力は idle", () => {
    expect(detectStatus({ ...quiet, tail: "Done. 42 files changed." })).toBe(
      STATUS.IDLE
    );
  });

  test("シェルプロンプトの後ろにコマンドが入力済みなら idle のまま", () => {
    expect(detectStatus({ ...quiet, tail: "PS C:\\app> npm test" })).toBe(
      STATUS.IDLE
    );
  });
});

test.describe("detectStatus - 優先順位", () => {
  test("Claude の入力ボックスはシェルプロンプトより優先される", () => {
    const tail = ["PS C:\\app> claude", "│ > "].join("\n");
    const status = detectStatus({
      tail,
      msSinceLastOutput: QUIET_MS + 100,
      exited: false,
    });
    expect(status).toBe(STATUS.WAITING);
  });

  test("直近 10 行より前の入力待ちパターンは無視する", () => {
    const tail = ["│ > ", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join(
      "\n"
    );
    const status = detectStatus({
      tail,
      msSinceLastOutput: QUIET_MS + 100,
      exited: false,
    });
    expect(status).toBe(STATUS.IDLE);
  });
});

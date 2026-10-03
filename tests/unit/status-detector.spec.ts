import { test, expect } from "@playwright/test";
import {
  detectStatus,
  stripAnsi,
  lastNonEmptyLine,
  STATUS,
  QUIET_MS,
} from "../../lib/status-detector";

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

  test("中間バイトを含む CSI も除去する", () => {
    // カーソル形状の指定 ESC [ 0 SP q。実機の codex が出していて、
    // 英字だけを終端とみなす書き方では取り切れずに本文へ残っていた
    expect(stripAnsi("C:\\app\\panedeck\x1b[0 q")).toBe("C:\\app\\panedeck");
  });

  test("私用パラメータを含む CSI も除去する", () => {
    expect(stripAnsi("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
    expect(stripAnsi("\x1b[>4;2mx")).toBe("x");
  });

  test("OSC（タイトル設定）を消しても、その後ろは残す", () => {
    // PowerShell は起動のたびにタイトルを設定する。OSC の終端を見ずに
    // 「以降すべて」を消すと、そこから後の出力が判定から丸ごと消える
    const tail = "\x1b]0;C:\\Windows\\powershell.exe\x07プロンプトが続く";
    expect(stripAnsi(tail)).toBe("プロンプトが続く");
  });

  test("ST (ESC \\) 終端の OSC も扱える", () => {
    expect(stripAnsi("\x1b]0;title\x1b\\after")).toBe("after");
  });

  test("OSC が複数あっても後続を失わない", () => {
    const tail = "\x1b]0;a\x07one\x1b]0;b\x07two\x1b]0;c\x07three";
    expect(stripAnsi(tail)).toBe("onetwothree");
  });

  test("OSC と CSI が混ざっていても後続を残す", () => {
    const tail = "\x1b]0;title\x07\x1b[31m│ > \x1b[0m";
    expect(stripAnsi(tail)).toBe("│ > ");
  });

  test("単独の ST (ESC \\) も取り除く", () => {
    // OSC-8 のハイパーリンクは ESC] ... ESC\ リンク文字 ESC] ... ESC\ の形。
    // 実機のログでは ST が残って URL 行に紛れていた
    expect(stripAnsi("\x1b]8;;http://x\x1b\\見える文字\x1b]8;;\x1b\\")).toBe(
      "見える文字"
    );
  });

  test("開始が切れて宙に浮いた ST も取り除く", () => {
    // 判定は末尾 2000 文字だけを見るので、その境界が OSC の途中に落ちると
    // 開始（ESC ]）が窓の外に出て、終端だけが残る
    expect(stripAnsi("latest\x1b\\リンク文字")).toBe("latestリンク文字");
  });

  test("終端の無い OSC は次のエスケープまでで止める", () => {
    // ログの途中で切れている場合。後続を全部捨てるよりは被害が小さい
    expect(stripAnsi("\x1b]0;broken\x1b[31mred")).toBe("red");
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
    });
    expect(status).toBe(STATUS.EXITED);
  });

  test("出力が流れていても exited が優先される", () => {
    const status = detectStatus({
      tail: "building...",
      msSinceLastOutput: 0,
      exited: true,
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

test.describe("detectStatus - 末尾の空行", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100, exited: false };

  test("末尾に空行が続いても、その手前の入力待ちを見落とさない", () => {
    // 全画面 TUI は画面下を空行で埋める。行数で窓を切ると、中身が窓の外へ
    // 押し出される。実際に codex のログでは 91 行中 59 行目までしか中身が
    // 無く、末尾 10 行はすべて空行だった
    const tail = ["  Press enter to continue", ...Array(30).fill("")].join("\n");
    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.WAITING);
  });

  test("空行を除いた直近 10 行より前のパターンは無視する", () => {
    // 窓の広さ自体は変えない。数え方を「中身のある行」にするだけ
    const tail = [
      "│ > ",
      ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
      "",
      "",
    ].join("\n");
    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.IDLE);
  });

  test("空行しか無ければ idle", () => {
    expect(detectStatus({ ...quiet, tail: "\n\n\n\n" })).toBe(STATUS.IDLE);
  });
});

test.describe("detectStatus - OSC を挟んだ出力", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100, exited: false };

  test("タイトル設定の後に入力ボックスが来ても waiting と判定する", () => {
    // 実際に codex を走らせて採取した形。シェルがタイトルを設定してから
    // エージェントの UI が描かれるため、OSC の扱いを誤ると判定できない
    const tail = [
      "\x1b]0;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07",
      "╭────────╮",
      "│ >      │",
      "╰────────╯",
    ].join("\n");

    expect(detectStatus({ ...quiet, tail })).toBe(STATUS.WAITING);
  });
});

test.describe("detectStatus - 待機パターンの差し替え", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100, exited: false };

  test("渡したパターンで判定する", () => {
    const status = detectStatus({
      ...quiet,
      tail: "codex awaiting instructions >>>",
      waitingPatterns: [/>>>\s*$/],
    });
    expect(status).toBe(STATUS.WAITING);
  });

  test("渡したパターンに一致しなければ idle", () => {
    const status = detectStatus({
      ...quiet,
      tail: "Done.",
      waitingPatterns: [/>>>\s*$/],
    });
    expect(status).toBe(STATUS.IDLE);
  });

  test("差し替えると既定のパターンは使われない", () => {
    // Claude の入力ボックスでも、別エージェント用のパターンなら waiting にしない
    const status = detectStatus({
      ...quiet,
      tail: "│ > ",
      waitingPatterns: [/>>>\s*$/],
    });
    expect(status).toBe(STATUS.IDLE);
  });

  test("空配列を渡すと何も入力待ちにならない", () => {
    const status = detectStatus({ ...quiet, tail: "│ > ", waitingPatterns: [] });
    expect(status).toBe(STATUS.IDLE);
  });

  test("未指定なら既定のパターンで判定する（現行動作）", () => {
    expect(detectStatus({ ...quiet, tail: "│ > " })).toBe(STATUS.WAITING);
  });

  test("配列でない値を渡しても落ちず既定にフォールバックする", () => {
    // 型では弾かれる値。実行時に流れ込んだ場合の保険を見る
    const notAnArray = "not-an-array" as any;
    expect(
      detectStatus({ ...quiet, tail: "│ > ", waitingPatterns: notAnArray })
    ).toBe(STATUS.WAITING);
    expect(detectStatus({ ...quiet, tail: "│ > ", waitingPatterns: null as any })).toBe(
      STATUS.WAITING
    );
  });

  test("終了・実行中の判定はパターンより優先される", () => {
    expect(
      detectStatus({
        tail: ">>>",
        msSinceLastOutput: 0,
        exited: false,
        waitingPatterns: [/>>>/],
      })
    ).toBe(STATUS.RUNNING);

    expect(
      detectStatus({
        tail: ">>>",
        msSinceLastOutput: 9999,
        exited: true,
        waitingPatterns: [/>>>/],
      })
    ).toBe(STATUS.EXITED);
  });
});

/**
 * 「入力欄で待っている」と「質問で止まっている」を分ける（#27）。
 *
 * 同じ waiting でも意味が違う。入力欄なら打った文字は指示になるが、確認
 * ダイアログや選択肢なら**打鍵がそのまま回答になる**。見ずに送る経路
 * （入力待ちのみの一斉入力・自動送信）では、ここが「配達」と「承認」を
 * 分ける唯一の壁になる。
 *
 * 分割は asking のパターンが与えられたときだけ働く。**区別できないなら
 * ready とは言わない** —— 危険なのは asking を取りこぼす側なので、
 * 見分けられないプロファイルは従来の waiting にまとめて落ちる。
 */
test.describe("detectStatus - ready / asking の分割", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100 };
  const READY = [/│\s*>/];
  const ASKING = [/❯/, /\(y\/n\)/i, /\[y\/n\]/i];

  test("質問で止まっていれば asking", () => {
    expect(
      detectStatus({
        ...quiet,
        tail: "Do you want to proceed? (y/n)",
        readyPatterns: READY,
        askingPatterns: ASKING,
      })
    ).toBe(STATUS.ASKING);
  });

  test("入力欄で待っていれば ready", () => {
    expect(
      detectStatus({
        ...quiet,
        tail: "╭────────╮\n│ >      │\n╰────────╯",
        readyPatterns: READY,
        askingPatterns: ASKING,
      })
    ).toBe(STATUS.READY);
  });

  /**
   * 画面の書き換え途中や、ダイアログの上に入力欄の枠が残っているときは
   * 両方が見える。迷ったら送らない側へ倒す。
   */
  test("両方見えているときは asking を優先する", () => {
    expect(
      detectStatus({
        ...quiet,
        tail: "│ >      │\nAllow this command? (y/n)",
        readyPatterns: READY,
        askingPatterns: ASKING,
      })
    ).toBe(STATUS.ASKING);
  });

  test("どちらにも当てはまらなければ idle", () => {
    expect(
      detectStatus({
        ...quiet,
        tail: "Done.",
        readyPatterns: READY,
        askingPatterns: ASKING,
      })
    ).toBe(STATUS.IDLE);
  });

  test("分割を持たないプロファイルは従来どおり waiting", () => {
    expect(
      detectStatus({ ...quiet, tail: "│ > ", waitingPatterns: READY })
    ).toBe(STATUS.WAITING);
  });

  /**
   * asking を見分けられないのに ready と言い切ると、確認ダイアログが
   * 「送ってよい」側に回る。分割は asking があるときだけ有効にする。
   */
  test("ready だけ与えられても ready とは言わない", () => {
    expect(
      detectStatus({
        ...quiet,
        tail: "│ > ",
        readyPatterns: READY,
        waitingPatterns: READY,
      })
    ).toBe(STATUS.WAITING);
  });

  test("asking は実行中より優先されない（出力が動いていれば running）", () => {
    expect(
      detectStatus({
        msSinceLastOutput: 0,
        tail: "Allow this command? (y/n)",
        readyPatterns: READY,
        askingPatterns: ASKING,
      })
    ).toBe(STATUS.RUNNING);
  });
});

/**
 * 知らない画面は ready に落とさない（#27）。
 *
 * `❯` のようなカーソルは、入力欄にも選択式ダイアログにも出る。実機の採取で
 * 分かったのは、**通常のプロンプトにはフッター（`manual mode on` など）が
 * あり、ダイアログの間は消える**こと。そこで ready は「入力欄だと言える印」が
 * あるときだけにし、`❯` しか無い画面は「何かが待っているが見分けられない」
 * として waiting に落とす。
 *
 * こうしておくと、将来 PaneDeck が知らないダイアログが増えても、
 * 壊れ方が ready 側（送ってよい）ではなく waiting 側（送らない）になる。
 */
test.describe("detectStatus - 判別できない待ちは waiting に落とす", () => {
  const quiet = { msSinceLastOutput: QUIET_MS + 100 };
  const patterns = {
    askingPatterns: [/Do you want to/i],
    readyPatterns: [/\bmanual mode on\b/i],
    waitingPatterns: [/❯/],
  };

  test("入力欄の印があれば ready", () => {
    expect(
      detectStatus({ ...quiet, tail: "❯\n⏸ manual mode on · ? for shortcuts", ...patterns })
    ).toBe(STATUS.READY);
  });

  test("質問の印があれば asking", () => {
    expect(
      detectStatus({ ...quiet, tail: "Do you want to create note.txt?\n❯ 1 Yes", ...patterns })
    ).toBe(STATUS.ASKING);
  });

  /** 知らない選択式ダイアログ。カーソルはあるが入力欄の印は無い */
  test("カーソルだけで入力欄の印が無ければ waiting", () => {
    expect(
      detectStatus({ ...quiet, tail: "Which approach?\n❯ 1. A\n  2. B", ...patterns })
    ).toBe(STATUS.WAITING);
  });

  test("どの印も無ければ idle", () => {
    expect(detectStatus({ ...quiet, tail: "Done.", ...patterns })).toBe(STATUS.IDLE);
  });
});

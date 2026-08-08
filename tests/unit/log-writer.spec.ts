import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { LogWriter, logFileName } from "../../lib/log-writer";

const TEMP_DIR = path.join(__dirname, "temp-logs");

/** 2026-08-03 12:34:56 (ローカル時刻) */
const FIXED_TIME = new Date(2026, 7, 3, 12, 34, 56).getTime();

test.beforeEach(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function setup(options = {}) {
  return new LogWriter({ dir: TEMP_DIR, now: () => FIXED_TIME, ...options });
}

function filesInTemp() {
  return fs.readdirSync(TEMP_DIR).sort();
}

test.describe("logFileName", () => {
  test("タイトルと起動時刻を含める", () => {
    expect(logFileName("repo-a", FIXED_TIME)).toBe("repo-a-20260803-123456.log");
  });

  test("ファイル名に使えない記号を置き換える", () => {
    // Windows で禁止されている文字。混ざると保存そのものが失敗する
    expect(logFileName('a\\b/c:d*e?f"g<h>i|j', FIXED_TIME)).toBe(
      "a_b_c_d_e_f_g_h_i_j-20260803-123456.log"
    );
  });

  test("空のタイトルでも名前が付く", () => {
    expect(logFileName("", FIXED_TIME)).toBe("session-20260803-123456.log");
    expect(logFileName("   ", FIXED_TIME)).toBe("session-20260803-123456.log");
  });

  test("長すぎるタイトルは切り詰める", () => {
    const name = logFileName("あ".repeat(300), FIXED_TIME);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith("-20260803-123456.log")).toBe(true);
  });
});

test.describe("索引への記録", () => {
  const indexPath = () => path.join(TEMP_DIR, ".panedeck-logs.json");

  test("作ったファイルを索引に載せる", () => {
    // 片付け（lib/log-retention）は索引に載っているものしか消さない。
    // ここで記録しないと、そのログは永久に片付かない
    const writer = new LogWriter({
      dir: TEMP_DIR,
      now: () => FIXED_TIME,
      indexPath: indexPath(),
    });
    const filePath = writer.open("s1", "repo-a");

    const index = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
    expect(index).toHaveLength(1);
    expect(index[0].file).toBe(filePath);
    expect(index[0].createdAt).toBe(FIXED_TIME);
  });

  test("indexPath を渡さなければ記録しない", () => {
    const writer = setup();
    writer.open("s1", "repo-a");

    expect(fs.existsSync(indexPath())).toBe(false);
  });

  test("記録に失敗しても書き出しは続く", () => {
    const blocked = path.join(TEMP_DIR, "blocked");
    fs.writeFileSync(blocked, "not a dir", "utf8");

    const writer = new LogWriter({
      dir: TEMP_DIR,
      now: () => FIXED_TIME,
      indexPath: path.join(blocked, "index.json"),
    });

    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", "still written");
    expect(writer.flush()).toEqual([]);

    expect(fs.readFileSync(filePath, "utf8")).toBe("still written");
  });
});

test.describe("open", () => {
  test("セッションごとのファイルパスを返す", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");

    expect(filePath).toBe(path.join(TEMP_DIR, "repo-a-20260803-123456.log"));
  });

  test("出力先ディレクトリが無ければ作る", () => {
    const nested = path.join(TEMP_DIR, "nested", "deep");
    const writer = new LogWriter({ dir: nested, now: () => FIXED_TIME });
    writer.open("s1", "repo-a");
    writer.append("s1", "x");
    writer.flush();

    expect(fs.existsSync(nested)).toBe(true);
  });

  test("同じ名前が既にあれば連番で避ける", () => {
    // 同じ秒に同名のセッションを 2 つ開くと衝突する
    const writer = setup();
    const first = writer.open("s1", "repo-a");
    const second = writer.open("s2", "repo-a");

    writer.append("s1", "one");
    writer.append("s2", "two");
    writer.flush();

    expect(second).not.toBe(first);
    expect(filesInTemp()).toEqual([
      "repo-a-20260803-123456-2.log",
      "repo-a-20260803-123456.log",
    ]);
  });

  test("開いていないセッションへの append は捨てる", () => {
    const writer = setup();
    writer.append("unknown", "x");
    writer.flush();

    expect(filesInTemp()).toEqual([]);
  });
});

test.describe("append / flush", () => {
  test("flush するまで書かない（バッファリング）", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", "hello");

    expect(fs.existsSync(filePath)).toBe(false);

    writer.flush();
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
  });

  test("複数回の出力をまとめて追記する", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", "one ");
    writer.append("s1", "two ");
    writer.flush();
    writer.append("s1", "three");
    writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("one two three");
  });

  test("セッションごとに別ファイルへ書く", () => {
    const writer = setup();
    const a = writer.open("s1", "repo-a");
    const b = writer.open("s2", "repo-b");
    writer.append("s1", "AAA");
    writer.append("s2", "BBB");
    writer.flush();

    expect(fs.readFileSync(a, "utf8")).toBe("AAA");
    expect(fs.readFileSync(b, "utf8")).toBe("BBB");
  });

  test("空のバッファではファイルを作らない", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.flush();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("flush を繰り返しても重複して書かない", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", "once");
    writer.flush();
    writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("once");
  });
});

test.describe("ANSI エスケープの扱い", () => {
  const colored = "\x1b[31mred\x1b[0m plain";

  test("既定では除去して読みやすくする", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", colored);
    writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("red plain");
  });

  test("生のまま残すこともできる", () => {
    const writer = setup({ stripAnsi: false });
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", colored);
    writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe(colored);
  });
});

test.describe("close", () => {
  test("閉じるときに書き残しを吐き出す", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.append("s1", "tail");
    writer.close("s1");

    expect(fs.readFileSync(filePath, "utf8")).toBe("tail");
  });

  test("閉じた後の append は捨てる", () => {
    const writer = setup();
    const filePath = writer.open("s1", "repo-a");
    writer.close("s1");
    writer.append("s1", "too late");
    writer.flush();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("closeAll で全セッションを吐き出す", () => {
    const writer = setup();
    const a = writer.open("s1", "repo-a");
    const b = writer.open("s2", "repo-b");
    writer.append("s1", "AAA");
    writer.append("s2", "BBB");
    writer.closeAll();

    expect(fs.readFileSync(a, "utf8")).toBe("AAA");
    expect(fs.readFileSync(b, "utf8")).toBe("BBB");
  });
});

test.describe("書き込み失敗", () => {
  /** 出力先をファイルにしてディレクトリを作れなくする */
  function brokenWriter() {
    const blocker = path.join(TEMP_DIR, "blocked");
    fs.writeFileSync(blocker, "not a directory", "utf8");
    return new LogWriter({ dir: blocker, now: () => FIXED_TIME });
  }

  test("例外を投げず、失敗したセッションを返す", () => {
    const writer = brokenWriter();
    writer.open("s1", "repo-a");
    writer.append("s1", "x");

    let failures: ReturnType<typeof writer.flush> = [];
    expect(() => {
      failures = writer.flush();
    }).not.toThrow();

    expect(failures).toHaveLength(1);
    expect(failures[0].id).toBe("s1");
    expect(failures[0].error).toBeTruthy();
  });

  test("一度失敗したセッションは書き込みをやめる", () => {
    // 出力のたびに失敗し続けると通知が止まらなくなる
    const writer = brokenWriter();
    writer.open("s1", "repo-a");
    writer.append("s1", "x");
    expect(writer.flush()).toHaveLength(1);

    writer.append("s1", "y");
    expect(writer.flush()).toHaveLength(0);
  });

  test("成功しているセッションは巻き添えにしない", () => {
    const writer = setup();
    const ok = writer.open("s1", "repo-a");
    writer.open("s2", "repo-b");
    // 片方だけ書けない状態にする
    writer.paths.set("s2", path.join(TEMP_DIR, "nope", "\0invalid"));

    writer.append("s1", "fine");
    writer.append("s2", "broken");
    const failures = writer.flush();

    expect(failures.map((f) => f.id)).toEqual(["s2"]);
    expect(fs.readFileSync(ok, "utf8")).toBe("fine");
  });
});

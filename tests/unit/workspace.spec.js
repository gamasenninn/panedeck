const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  serializeWorkspace,
  parseWorkspace,
  saveWorkspace,
  loadWorkspace,
  WORKSPACE_VERSION,
} = require("../../lib/workspace");

const TEMP_DIR = path.join(__dirname, "temp");

test.beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

const SESSIONS = [
  { id: "s1", title: "repo-a", cwd: "C:\\app\\repo-a", shell: "pwsh", args: ["-NoLogo"], status: "waiting" },
  { id: "s2", title: "repo-b", cwd: "C:\\app\\repo-b", shell: "pwsh", args: [], status: "running" },
];

test.describe("serializeWorkspace", () => {
  test("バージョンと名前を含める", () => {
    const ws = serializeWorkspace(SESSIONS, { name: "朝の巡回" });
    expect(ws.version).toBe(WORKSPACE_VERSION);
    expect(ws.name).toBe("朝の巡回");
  });

  test("復元に必要な項目だけを残す", () => {
    const ws = serializeWorkspace(SESSIONS);
    expect(ws.sessions).toEqual([
      { title: "repo-a", cwd: "C:\\app\\repo-a", shell: "pwsh", args: ["-NoLogo"] },
      { title: "repo-b", cwd: "C:\\app\\repo-b", shell: "pwsh", args: [] },
    ]);
  });

  test("実行時の情報 (id / status) は落とす", () => {
    const ws = serializeWorkspace(SESSIONS);
    expect(ws.sessions[0].id).toBeUndefined();
    expect(ws.sessions[0].status).toBeUndefined();
  });

  test("空の一覧も扱える", () => {
    expect(serializeWorkspace([]).sessions).toEqual([]);
  });

  test("name 未指定なら既定名を入れる", () => {
    expect(serializeWorkspace([]).name).toBeTruthy();
  });
});

test.describe("parseWorkspace", () => {
  test("シリアライズしたものを読み戻せる", () => {
    const text = JSON.stringify(serializeWorkspace(SESSIONS, { name: "夜の巡回" }));
    const ws = parseWorkspace(text);
    expect(ws.name).toBe("夜の巡回");
    expect(ws.sessions).toHaveLength(2);
    expect(ws.sessions[0].cwd).toBe("C:\\app\\repo-a");
  });

  test("cwd の無いセッションは捨てる", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ title: "壊れた" }, { cwd: "C:\\ok" }],
    });
    expect(parseWorkspace(text).sessions).toHaveLength(1);
    expect(parseWorkspace(text).sessions[0].cwd).toBe("C:\\ok");
  });

  test("args が配列でなければ空配列に正規化する", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ cwd: "C:\\ok", args: "not-an-array" }],
    });
    expect(parseWorkspace(text).sessions[0].args).toEqual([]);
  });

  test("未知のフィールドは無視する", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ cwd: "C:\\ok", evil: "rm -rf" }],
    });
    expect(parseWorkspace(text).sessions[0].evil).toBeUndefined();
  });

  test("JSON として壊れていたら例外を投げる", () => {
    expect(() => parseWorkspace("{ not json")).toThrow(/ワークスペース/);
  });

  test("sessions が配列でなければ例外を投げる", () => {
    expect(() => parseWorkspace(JSON.stringify({ version: 1 }))).toThrow(
      /ワークスペース/
    );
  });

  test("バージョンが新しすぎたら例外を投げる", () => {
    const text = JSON.stringify({ version: WORKSPACE_VERSION + 1, sessions: [] });
    expect(() => parseWorkspace(text)).toThrow(/バージョン/);
  });
});

test.describe("saveWorkspace / loadWorkspace", () => {
  test("保存したファイルを読み戻せる", () => {
    const filePath = path.join(TEMP_DIR, "roundtrip.json");
    saveWorkspace(filePath, SESSIONS, { name: "往復" });

    expect(fs.existsSync(filePath)).toBe(true);
    const ws = loadWorkspace(filePath);
    expect(ws.name).toBe("往復");
    expect(ws.sessions.map((s) => s.title)).toEqual(["repo-a", "repo-b"]);
  });

  test("実ファイルの中身が読める JSON になっている", () => {
    const filePath = path.join(TEMP_DIR, "readable.json");
    saveWorkspace(filePath, SESSIONS);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("repo-a");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("存在しないファイルを読んだら例外を投げる", () => {
    const filePath = path.join(TEMP_DIR, "missing.json");
    expect(() => loadWorkspace(filePath)).toThrow();
  });

  test("保存先ディレクトリが無ければ作る", () => {
    const filePath = path.join(TEMP_DIR, "nested", "deep", "ws.json");
    saveWorkspace(filePath, SESSIONS);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("空のワークスペースも保存・復元できる", () => {
    const filePath = path.join(TEMP_DIR, "empty.json");
    saveWorkspace(filePath, []);
    expect(loadWorkspace(filePath).sessions).toEqual([]);
  });
});

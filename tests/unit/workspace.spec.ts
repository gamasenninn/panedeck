import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import type { Session } from "../../types/panedeck";
import {
  serializeWorkspace,
  parseWorkspace,
  saveWorkspace,
  loadWorkspace,
  tryLoadWorkspace,
  WORKSPACE_VERSION,
} from "../../lib/workspace";

const TEMP_DIR = path.join(__dirname, "temp");

test.beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

const SESSIONS: Array<Partial<Session>> = [
  { id: "s1", title: "repo-a", cwd: "C:\\app\\repo-a", shell: "pwsh", args: ["-NoLogo"], status: "waiting" },
  { id: "s2", title: "repo-b", cwd: "C:\\app\\repo-b", shell: "pwsh", args: [], status: "running" },
];

/** エージェントを混ぜたデッキ（#1: セッションごとの起動コマンド） */
const MIXED_SESSIONS: Array<Partial<Session>> = [
  { id: "s1", title: "repo-a", cwd: "C:\\app\\repo-a", initialCommand: "claude" },
  { id: "s2", title: "repo-b", cwd: "C:\\app\\repo-b", initialCommand: "codex --resume" },
  { id: "s3", title: "repo-c", cwd: "C:\\app\\repo-c" },
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
    // 保存形には無い項目。混ざっていないことを見るので型からは外して覗く
    const entry: any = (ws.sessions[0]);
    expect(entry.id).toBeUndefined();
    expect(entry.status).toBeUndefined();
  });

  test("空の一覧も扱える", () => {
    expect(serializeWorkspace([]).sessions).toEqual([]);
  });

  test("name 未指定なら既定名を入れる", () => {
    expect(serializeWorkspace([]).name).toBeTruthy();
  });

  test("セッションごとの起動コマンドを保存する", () => {
    const ws = serializeWorkspace(MIXED_SESSIONS);
    expect(ws.sessions.map((s) => s.initialCommand)).toEqual([
      "claude",
      "codex --resume",
      undefined,
    ]);
  });

  test("起動コマンドが空なら項目自体を出さない", () => {
    // 項目の有無で「旧ファイル」と「明示的に空」を区別しないため、
    // 空はそもそも書かない。読み手はどちらも「未指定」として扱える。
    const ws = serializeWorkspace([
      { cwd: "C:\\ok", initialCommand: "" },
      { cwd: "C:\\ok2", initialCommand: "   " },
    ]);
    expect(Object.keys(ws.sessions[0])).not.toContain("initialCommand");
    expect(Object.keys(ws.sessions[1])).not.toContain("initialCommand");
  });

  test("起動コマンドの前後の空白は落として保存する", () => {
    const ws = serializeWorkspace([{ cwd: "C:\\ok", initialCommand: "  claude  " }]);
    expect(ws.sessions[0].initialCommand).toBe("claude");
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
    const entry: any = (parseWorkspace(text).sessions[0]);
    expect(entry.evil).toBeUndefined();
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

  test("セッションごとの起動コマンドを読み戻す", () => {
    const text = JSON.stringify(serializeWorkspace(MIXED_SESSIONS));
    expect(parseWorkspace(text).sessions.map((s) => s.initialCommand)).toEqual([
      "claude",
      "codex --resume",
      undefined,
    ]);
  });

  test("起動コマンドの無い既存ファイルも読める（後方互換）", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ title: "repo-a", cwd: "C:\\app\\repo-a", shell: "pwsh", args: [] }],
    });
    const ws = parseWorkspace(text);
    expect(ws.sessions).toHaveLength(1);
    expect(ws.sessions[0].initialCommand).toBeUndefined();
  });

  test("agent の無い既存ファイルも読める（後方互換）", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ cwd: "C:\\app\\repo-a", initialCommand: "claude" }],
    });
    expect(parseWorkspace(text).sessions[0].agent).toBeUndefined();
  });

  test("agent が文字列でなければ捨てる", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [{ cwd: "C:\\a", agent: 7 }, { cwd: "C:\\b", agent: "" }],
    });
    expect(parseWorkspace(text).sessions.map((s) => s.agent)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("起動コマンドが文字列でなければ捨てる", () => {
    const text = JSON.stringify({
      version: WORKSPACE_VERSION,
      sessions: [
        { cwd: "C:\\a", initialCommand: 42 },
        { cwd: "C:\\b", initialCommand: ["claude"] },
        { cwd: "C:\\c", initialCommand: "" },
      ],
    });
    const ws = parseWorkspace(text);
    expect(ws.sessions.map((s) => s.initialCommand)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
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

  test.describe("tryLoadWorkspace（自動復元用の読み込み）", () => {
    test("正しいファイルは loadWorkspace と同じ結果を返す", () => {
      const filePath = path.join(TEMP_DIR, "try-ok.json");
      saveWorkspace(filePath, SESSIONS, { name: "自動" });

      expect(tryLoadWorkspace(filePath)).toEqual(loadWorkspace(filePath));
    });

    test("ファイルが無ければ null を返す（例外にしない）", () => {
      // 初回起動では必ずこの経路を通る。無いことは異常ではない
      const filePath = path.join(TEMP_DIR, "try-missing.json");
      expect(tryLoadWorkspace(filePath)).toBeNull();
    });

    test("JSON が壊れていても null を返す", () => {
      const filePath = path.join(TEMP_DIR, "try-broken.json");
      fs.writeFileSync(filePath, "{ これは JSON ではない", "utf8");

      expect(() => tryLoadWorkspace(filePath)).not.toThrow();
      expect(tryLoadWorkspace(filePath)).toBeNull();
    });

    test("形が違っても null を返す", () => {
      const filePath = path.join(TEMP_DIR, "try-shape.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), "utf8");

      expect(tryLoadWorkspace(filePath)).toBeNull();
    });

    test("バージョンが新しすぎても null を返す", () => {
      const filePath = path.join(TEMP_DIR, "try-version.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: WORKSPACE_VERSION + 1, sessions: [] }),
        "utf8"
      );

      expect(tryLoadWorkspace(filePath)).toBeNull();
    });

    test("セッションが空のファイルは null ではなく空の構成を返す", () => {
      // 「全部閉じた状態」を保存したのであって、壊れているわけではない
      const filePath = path.join(TEMP_DIR, "try-empty.json");
      saveWorkspace(filePath, []);

      expect(tryLoadWorkspace(filePath).sessions).toEqual([]);
    });
  });

  test("空のワークスペースも保存・復元できる", () => {
    const filePath = path.join(TEMP_DIR, "empty.json");
    saveWorkspace(filePath, []);
    expect(loadWorkspace(filePath).sessions).toEqual([]);
  });

  test("エージェントプロファイルも往復する", () => {
    const filePath = path.join(TEMP_DIR, "agents.json");
    saveWorkspace(filePath, [
      { cwd: "C:\\a", agent: "claude", initialCommand: "claude" },
      { cwd: "C:\\b", agent: "codex", initialCommand: "codex" },
      { cwd: "C:\\c" },
    ]);

    expect(loadWorkspace(filePath).sessions.map((s) => s.agent)).toEqual([
      "claude",
      "codex",
      undefined,
    ]);
  });

  test("エージェントプロファイルも往復する（自動復元用）", () => {
    const filePath = path.join(TEMP_DIR, "auto.json");
    saveWorkspace(filePath, MIXED_SESSIONS);
    expect(tryLoadWorkspace(filePath).sessions).toHaveLength(3);
  });

  test("セッションごとに異なる起動コマンドが往復する", () => {
    const filePath = path.join(TEMP_DIR, "mixed.json");
    saveWorkspace(filePath, MIXED_SESSIONS, { name: "混成デッキ" });

    const ws = loadWorkspace(filePath);
    expect(ws.sessions.map((s) => [s.cwd, s.initialCommand])).toEqual([
      ["C:\\app\\repo-a", "claude"],
      ["C:\\app\\repo-b", "codex --resume"],
      ["C:\\app\\repo-c", undefined],
    ]);
  });
});

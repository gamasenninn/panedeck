const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_SETTINGS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  normalizeSettings,
  readSettings,
  writeSettings,
  updateSettings,
} = require("../../lib/settings");

const TEMP_DIR = path.join(__dirname, "temp-settings");

test.beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

test.describe("normalizeSettings", () => {
  test("既定は 12", () => {
    expect(DEFAULT_SETTINGS.fontSize).toBe(12);
    expect(normalizeSettings({}).fontSize).toBe(12);
    expect(normalizeSettings(undefined).fontSize).toBe(12);
    expect(normalizeSettings(null).fontSize).toBe(12);
  });

  test("範囲内の値はそのまま通す", () => {
    expect(normalizeSettings({ fontSize: 16 }).fontSize).toBe(16);
  });

  test("境界値はそのまま通す", () => {
    expect(normalizeSettings({ fontSize: FONT_SIZE_MIN }).fontSize).toBe(FONT_SIZE_MIN);
    expect(normalizeSettings({ fontSize: FONT_SIZE_MAX }).fontSize).toBe(FONT_SIZE_MAX);
  });

  test("範囲外の数値は端に丸める", () => {
    // 数値として読めている以上、既定へ戻すより端に寄せるほうが意図に近い
    expect(normalizeSettings({ fontSize: 0 }).fontSize).toBe(FONT_SIZE_MIN);
    expect(normalizeSettings({ fontSize: -5 }).fontSize).toBe(FONT_SIZE_MIN);
    expect(normalizeSettings({ fontSize: 999 }).fontSize).toBe(FONT_SIZE_MAX);
  });

  test("小数は整数に丸める", () => {
    expect(normalizeSettings({ fontSize: 13.7 }).fontSize).toBe(14);
  });

  test("数値として読めない値は既定にする", () => {
    // 解釈できないものを端に寄せるのは推測になるので、既定へ戻す
    for (const bogus of ["abc", null, undefined, {}, [], NaN, Infinity, true]) {
      expect(normalizeSettings({ fontSize: bogus }).fontSize).toBe(
        DEFAULT_SETTINGS.fontSize
      );
    }
  });

  test("数字の文字列は受け入れる（入力欄からは文字列で来る）", () => {
    expect(normalizeSettings({ fontSize: "18" }).fontSize).toBe(18);
  });

  test("未知のフィールドは持ち込まない", () => {
    const settings = normalizeSettings({ fontSize: 14, evil: "rm -rf" });
    expect(Object.keys(settings).sort()).toEqual([
      "autoLog",
      "autoRestore",
      "fontSize",
      "logDir",
      "logStripAnsi",
    ]);
  });
});

test.describe("normalizeSettings - ログの自動保存", () => {
  test("既定は無効", () => {
    // 保持期間の上限がまだ無く、放っておくと際限なく溜まる。
    // ディスクへ黙って書き続けるより、明示的に選ばせる
    expect(DEFAULT_SETTINGS.autoLog).toBe(false);
    expect(normalizeSettings({}).autoLog).toBe(false);
  });

  test("真偽値はそのまま通す", () => {
    expect(normalizeSettings({ autoLog: true }).autoLog).toBe(true);
  });

  test("真偽値でない値は既定にする", () => {
    for (const bogus of ["yes", 1, null, {}]) {
      expect(normalizeSettings({ autoLog: bogus }).autoLog).toBe(false);
    }
  });

  test("ANSI は既定で除去する（後から読むため）", () => {
    expect(DEFAULT_SETTINGS.logStripAnsi).toBe(true);
    expect(normalizeSettings({ logStripAnsi: false }).logStripAnsi).toBe(false);
    expect(normalizeSettings({ logStripAnsi: "no" }).logStripAnsi).toBe(true);
  });

  test("出力先の既定は空（呼び出し側が既定の場所を決める）", () => {
    expect(DEFAULT_SETTINGS.logDir).toBe("");
    expect(normalizeSettings({ logDir: "C:\\logs" }).logDir).toBe("C:\\logs");
  });

  test("出力先が文字列でなければ既定にする", () => {
    for (const bogus of [123, null, {}, []]) {
      expect(normalizeSettings({ logDir: bogus }).logDir).toBe("");
    }
  });

  test("出力先の前後の空白は落とす", () => {
    expect(normalizeSettings({ logDir: "  C:\\logs  " }).logDir).toBe("C:\\logs");
  });
});

test.describe("normalizeSettings - 自動復元", () => {
  test("既定は有効", () => {
    // 無ければ何も起きないので、既定を有効にしても初回起動の挙動は変わらない
    expect(DEFAULT_SETTINGS.autoRestore).toBe(true);
    expect(normalizeSettings({}).autoRestore).toBe(true);
  });

  test("真偽値はそのまま通す", () => {
    expect(normalizeSettings({ autoRestore: false }).autoRestore).toBe(false);
    expect(normalizeSettings({ autoRestore: true }).autoRestore).toBe(true);
  });

  test("真偽値でない値は既定にする", () => {
    for (const bogus of ["yes", 1, 0, null, undefined, {}, []]) {
      expect(normalizeSettings({ autoRestore: bogus }).autoRestore).toBe(
        DEFAULT_SETTINGS.autoRestore
      );
    }
  });

  test("文字サイズと独立して保存できる", () => {
    const settings = normalizeSettings({ fontSize: 20, autoRestore: false });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, fontSize: 20, autoRestore: false });
  });
});

test.describe("readSettings", () => {
  test("ファイルが無ければ既定を返す", () => {
    const filePath = path.join(TEMP_DIR, "missing.json");
    expect(readSettings(filePath)).toEqual(DEFAULT_SETTINGS);
  });

  test("保存した値を読み戻せる", () => {
    const filePath = path.join(TEMP_DIR, "roundtrip.json");
    writeSettings(filePath, { fontSize: 20 });
    expect(readSettings(filePath).fontSize).toBe(20);
  });

  test("JSON が壊れていても例外を投げず既定を返す", () => {
    // 設定ファイル 1 つで起動不能にしない
    const filePath = path.join(TEMP_DIR, "broken.json");
    fs.writeFileSync(filePath, "{ これは JSON ではない", "utf8");

    expect(() => readSettings(filePath)).not.toThrow();
    expect(readSettings(filePath)).toEqual(DEFAULT_SETTINGS);
  });

  test("JSON だが形が違っても既定を返す", () => {
    const filePath = path.join(TEMP_DIR, "wrong-shape.json");
    fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), "utf8");

    expect(readSettings(filePath)).toEqual(DEFAULT_SETTINGS);
  });

  test("壊れた値を含んでいても読める項目は活かす", () => {
    const filePath = path.join(TEMP_DIR, "partial.json");
    fs.writeFileSync(filePath, JSON.stringify({ fontSize: "abc" }), "utf8");

    expect(readSettings(filePath).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });
});

test.describe("writeSettings", () => {
  test("保存先ディレクトリが無ければ作る", () => {
    const filePath = path.join(TEMP_DIR, "nested", "deep", "settings.json");
    writeSettings(filePath, { fontSize: 14 });

    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("実ファイルの中身が読める JSON になっている", () => {
    const filePath = path.join(TEMP_DIR, "readable.json");
    writeSettings(filePath, { fontSize: 14 });

    const raw = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).fontSize).toBe(14);
  });

  test("正規化してから書く", () => {
    const filePath = path.join(TEMP_DIR, "normalized.json");
    // 未知のフィールドはそもそも型で弾かれる。手で編集されたファイル相当を渡す
    writeSettings(filePath, /** @type {any} */ ({ fontSize: 999, evil: "x" }));

    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(saved.fontSize).toBe(FONT_SIZE_MAX);
    expect(saved.evil).toBeUndefined();
  });

  test("正規化後の値を返す", () => {
    const filePath = path.join(TEMP_DIR, "returned.json");
    expect(writeSettings(filePath, { fontSize: 1 }).fontSize).toBe(FONT_SIZE_MIN);
  });

  test("渡した項目だけを差し替え、他はそのまま書く", () => {
    // writeSettings は渡された形をそのまま正規化するので、部分更新には使えない。
    // 片方だけ送ると、もう片方が既定に戻ってしまう
    const filePath = path.join(TEMP_DIR, "whole-write.json");
    writeSettings(filePath, { fontSize: 20, autoRestore: false });
    writeSettings(filePath, { fontSize: 24 });

    expect(readSettings(filePath).autoRestore).toBe(DEFAULT_SETTINGS.autoRestore);
  });

  test("書き込みに失敗したら例外を投げる（呼び出し側で通知する）", () => {
    // 既存ファイルをディレクトリ扱いする経路を作って失敗させる
    const filePath = path.join(TEMP_DIR, "readable.json", "settings.json");
    expect(() => writeSettings(filePath, { fontSize: 12 })).toThrow();
  });
});

test.describe("updateSettings（部分更新）", () => {
  test("渡した項目だけを差し替え、他は保つ", () => {
    const filePath = path.join(TEMP_DIR, "update.json");
    writeSettings(filePath, { fontSize: 20, autoRestore: false });

    updateSettings(filePath, { fontSize: 24 });

    expect(readSettings(filePath)).toEqual({
      ...DEFAULT_SETTINGS,
      fontSize: 24,
      autoRestore: false,
    });
  });

  test("もう一方だけでも同じように保たれる", () => {
    const filePath = path.join(TEMP_DIR, "update2.json");
    writeSettings(filePath, { fontSize: 20, autoRestore: true });

    updateSettings(filePath, { autoRestore: false });

    expect(readSettings(filePath)).toEqual({
      ...DEFAULT_SETTINGS,
      fontSize: 20,
      autoRestore: false,
    });
  });

  test("ファイルがまだ無ければ既定に重ねる", () => {
    const filePath = path.join(TEMP_DIR, "update-new.json");

    updateSettings(filePath, { fontSize: 16 });

    expect(readSettings(filePath)).toEqual({ ...DEFAULT_SETTINGS, fontSize: 16 });
  });

  test("正規化後の設定全体を返す", () => {
    const filePath = path.join(TEMP_DIR, "update-return.json");
    expect(updateSettings(filePath, { fontSize: 999 })).toEqual({
      ...DEFAULT_SETTINGS,
      fontSize: FONT_SIZE_MAX,
    });
  });

  test("空の更新でも壊れない", () => {
    const filePath = path.join(TEMP_DIR, "update-empty.json");
    writeSettings(filePath, { fontSize: 18, autoRestore: false });

    expect(updateSettings(filePath, {})).toEqual({
      ...DEFAULT_SETTINGS,
      fontSize: 18,
      autoRestore: false,
    });
  });
});

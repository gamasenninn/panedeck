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
    expect(Object.keys(settings)).toEqual(["fontSize"]);
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

  test("書き込みに失敗したら例外を投げる（呼び出し側で通知する）", () => {
    // 既存ファイルをディレクトリ扱いする経路を作って失敗させる
    const filePath = path.join(TEMP_DIR, "readable.json", "settings.json");
    expect(() => writeSettings(filePath, { fontSize: 12 })).toThrow();
  });
});

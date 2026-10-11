import { test, expect } from "@playwright/test";
import path from "path";
import { folderFromArgv, folderStateDir } from "../../lib/open-folder";

/**
 * 起動の引数から「開くフォルダ」を決める（VS Code の `code <フォルダ>` と同じ考え）。
 *
 * Electron の argv は、パッケージ版なら [exe, ...引数]、開発時（`electron .`）なら
 * [electron, アプリの場所, ...引数]。Chromium や Playwright のスイッチ（`--inspect=0`
 * など）も混ざる
 */
const dirs = new Set([path.resolve("C:/system"), path.resolve("C:/work")]);
const isDirectory = (p: string) => dirs.has(p);

test.describe("起動の引数から開くフォルダを決める", () => {
  test("パッケージ版: 実行ファイルの次の引数がフォルダ", () => {
    const result = folderFromArgv(["C:/PaneDeck/PaneDeck.exe", "C:/system"], {
      defaultApp: false,
      isDirectory,
    });
    expect(result).toEqual({ folder: path.resolve("C:/system") });
  });

  test("開発時: アプリの場所は飛ばす", () => {
    const result = folderFromArgv(["electron.exe", "C:/app/panedeck", "C:/system"], {
      defaultApp: true,
      isDirectory,
    });
    expect(result).toEqual({ folder: path.resolve("C:/system") });
  });

  test("スイッチ（- で始まるもの）は読まない", () => {
    const result = folderFromArgv(
      ["electron.exe", "C:/app/panedeck", "--inspect=0", "--remote-debugging-port=0", "C:/work"],
      { defaultApp: true, isDirectory }
    );
    expect(result).toEqual({ folder: path.resolve("C:/work") });
  });

  /** Playwright はアプリの場所より前にスイッチを差す。アプリの場所をフォルダと読まない */
  test("スイッチがアプリの場所より前にあっても、アプリの場所は飛ばす", () => {
    const app = path.resolve("C:/app/panedeck");
    const result = folderFromArgv(
      ["electron.exe", "--inspect=0", "--remote-debugging-port=0", app, "C:/work"],
      { defaultApp: true, isDirectory: (p) => p === app || isDirectory(p) }
    );
    expect(result).toEqual({ folder: path.resolve("C:/work") });
  });

  test("引数が無ければ、フォルダは開かない（今までどおり）", () => {
    expect(folderFromArgv(["PaneDeck.exe"], { defaultApp: false, isDirectory })).toEqual({});
    expect(
      folderFromArgv(["electron.exe", "C:/app/panedeck"], { defaultApp: true, isDirectory })
    ).toEqual({});
  });

  /** 黙って今までどおりに起動すると、別の場所でサービスが動いたことに気づけない */
  test("無いフォルダを渡されたら、開かずにそう言う", () => {
    const result = folderFromArgv(["PaneDeck.exe", "C:/nowhere"], {
      defaultApp: false,
      isDirectory,
    });
    expect(result).toEqual({ missing: path.resolve("C:/nowhere") });
  });

  test("相対の指定は、起動した場所から解決する", () => {
    const result = folderFromArgv(["PaneDeck.exe", "."], {
      defaultApp: false,
      isDirectory: (p) => p === path.resolve("."),
    });
    expect(result).toEqual({ folder: path.resolve(".") });
  });
});

/**
 * フォルダを開いたときの、構成の控えの置き場所（2026-10-11）。
 *
 * フォルダを開いても共通の控え（last-session.json）を戻していたので、
 * `C:\system` を開いたら本体・受付のペインが出て、同じ会話を二重に再開した。
 * VS Code と同じく、構成はフォルダごとに持つ
 */
test.describe("構成の控えの置き場所", () => {
  const BASE = path.resolve("C:/Users/me/AppData/Roaming/panedeck");

  test("フォルダを開いていなければ、今までどおり設定と同じ場所", () => {
    expect(folderStateDir(BASE, undefined)).toBe(BASE);
  });

  test("フォルダを開いていれば、folders/ の下のそのフォルダ用の場所", () => {
    const dir = folderStateDir(BASE, path.resolve("C:/system"));
    expect(path.dirname(dir)).toBe(path.join(BASE, "folders"));
    // 人が見て分かるように、フォルダの名前を頭に付ける
    expect(path.basename(dir)).toMatch(/^system-[0-9a-f]{8}$/);
  });

  test("同じフォルダなら、毎回同じ場所", () => {
    const folder = path.resolve("C:/system");
    expect(folderStateDir(BASE, folder)).toBe(folderStateDir(BASE, folder));
  });

  test("名前が同じでも、別のフォルダなら別の場所", () => {
    expect(folderStateDir(BASE, path.resolve("C:/a/system"))).not.toBe(
      folderStateDir(BASE, path.resolve("C:/b/system"))
    );
  });

  test("大文字小文字を区別しないなら、c:\\system と C:\\System は同じ場所", () => {
    const options = { caseInsensitive: true };
    expect(folderStateDir(BASE, "c:\\system", options)).toBe(
      folderStateDir(BASE, "C:\\System", options)
    );
  });

  test("ドライブの直下でも名前が空にならない", () => {
    expect(path.basename(folderStateDir(BASE, "C:\\"))).toMatch(/^[^-]+-[0-9a-f]{8}$/);
  });
});

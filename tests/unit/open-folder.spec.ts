import { test, expect } from "@playwright/test";
import path from "path";
import { folderFromArgv } from "../../lib/open-folder";

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

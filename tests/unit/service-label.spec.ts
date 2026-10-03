import { test, expect } from "@playwright/test";
import { serviceSummary, serviceLabel } from "../../renderer/service-label";
import type { ServiceState } from "../../types/panedeck";

/**
 * 裏のコマンドの様子を、どう言うか（#29）。
 *
 * **落ち続けていることを隠さない**のがこの関数の仕事。判断だけを出して、
 * 描画は呼び出し側に残す。
 */

const running: ServiceState = {
  name: "feed",
  status: "running",
  restarts: 0,
  lastExitCode: null,
};

test.describe("serviceSummary（ツールバーの 1 行）", () => {
  test("サービスが無ければ出さない", () => {
    expect(serviceSummary([])).toBeNull();
  });

  test("全部走っていれば件数だけ", () => {
    expect(serviceSummary([running, { ...running, name: "b" }])).toEqual({
      text: "サービス 2",
      failing: false,
    });
  });

  /** 起こし直している最中は、何回落ちたかまで出す */
  test("起こし直し中は回数を添える", () => {
    expect(
      serviceSummary([running, { ...running, name: "b", status: "restarting", restarts: 3 }])
    ).toEqual({ text: "サービス 2（再起動中 1・計 3 回）", failing: true });
  });

  test("止まったものがあれば出す", () => {
    expect(
      serviceSummary([{ ...running, status: "stopped", lastExitCode: 0 }])
    ).toEqual({ text: "サービス 1（停止 1）", failing: true });
  });
});

test.describe("serviceLabel（一覧の 1 行）", () => {
  test("走っているとき", () => {
    expect(serviceLabel(running)).toBe("feed — 実行中");
  });

  test("起こし直し待ちのとき、回数と終了コードを出す", () => {
    expect(
      serviceLabel({ ...running, status: "restarting", restarts: 2, lastExitCode: 1 })
    ).toBe("feed — 再起動待ち（2 回目・終了コード 1）");
  });

  test("止まったとき", () => {
    expect(serviceLabel({ ...running, status: "stopped", lastExitCode: 0 })).toBe(
      "feed — 停止（終了コード 0）"
    );
  });

  /** 起動そのものに失敗すると -1 で来る。数字のままでは意味が分からない */
  test("起動できなかったときは数字で済ませない", () => {
    expect(
      serviceLabel({ ...running, status: "restarting", restarts: 1, lastExitCode: -1 })
    ).toBe("feed — 再起動待ち（1 回目・起動できず）");
  });
});

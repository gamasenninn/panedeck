import { test, expect } from "@playwright/test";
import {
  sanitizeValue,
  renderTemplate,
  templateValues,
} from "../../lib/trigger-template";

/**
 * トリガーが差し込む文字列は、**ユーザーが打ったのと同じ扱い**でエージェントへ
 * 送られる（#28）。値に改行や制御文字が混ざると、そこで入力が確定して
 * 残りが次のメッセージになる。置換する値は必ず均す。
 */
test.describe("sanitizeValue", () => {
  test("文字列はそのまま", () => {
    expect(sanitizeValue("abc-123")).toBe("abc-123");
  });

  test("数値と真偽値は文字列にする", () => {
    expect(sanitizeValue(42)).toBe("42");
    expect(sanitizeValue(true)).toBe("true");
  });

  /** CR は入力の確定そのもの。これが通ると残りが別のメッセージになる */
  test("改行は空白に均す", () => {
    expect(sanitizeValue("a\r\nb")).toBe("a b");
    expect(sanitizeValue("a\nb")).toBe("a b");
  });

  test("エスケープシーケンスなどの制御文字も落とす", () => {
    expect(sanitizeValue("a\x1b[31mb\x07c")).toBe("a [31mb c");
  });

  test("前後の空白は落とす", () => {
    expect(sanitizeValue("  hi  ")).toBe("hi");
  });

  test("文字列にできない値は空にする", () => {
    expect(sanitizeValue(null)).toBe("");
    expect(sanitizeValue(undefined)).toBe("");
    expect(sanitizeValue({ a: 1 })).toBe("");
    expect(sanitizeValue([1, 2])).toBe("");
  });
});

test.describe("renderTemplate", () => {
  test("{名前} を値で置き換える", () => {
    expect(renderTemplate("id={id} count={count}", { id: "x1", count: 3 })).toBe(
      "id=x1 count=3"
    );
  });

  /**
   * 解決できない名前はそのまま残す。空にすると「値が空だった」のか
   * 「名前が違った」のかが区別できず、黙って壊れる
   */
  test("知らない名前はそのまま残す", () => {
    expect(renderTemplate("id={nope}", { id: "x1" })).toBe("id={nope}");
  });

  test("値に混ざった改行はテンプレートを突き抜けない", () => {
    expect(renderTemplate("say: {body}", { body: "line1\nline2" })).toBe(
      "say: line1 line2"
    );
  });

  /** テンプレート自体の改行も落とす。送信は 1 通であるべき */
  test("テンプレートの改行も空白に均す", () => {
    expect(renderTemplate("a\nb", {})).toBe("a b");
  });

  test("同じ名前が何度出てもすべて置き換える", () => {
    expect(renderTemplate("{id}/{id}", { id: "7" })).toBe("7/7");
  });
});

/**
 * 保留していた行はまとめて 1 通で届ける（#28）。`{count}` は届ける行数、
 * 各フィールドは**最後の行**から採る（例の "last id={id}" がこれ）。
 */
test.describe("templateValues", () => {
  test("JSON の最上位フィールドと件数を渡す", () => {
    const values = templateValues([
      '{"id":"a1","kind":"mention"}',
      '{"id":"a2","kind":"reply"}',
    ]);
    expect(values.count).toBe(2);
    expect(values.id).toBe("a2");
    expect(values.kind).toBe("reply");
  });

  test("JSON でない行は {line} で渡す", () => {
    const values = templateValues(["plain text"]);
    expect(values.count).toBe(1);
    expect(values.line).toBe("plain text");
  });

  test("入れ子は渡さない（最上位だけ）", () => {
    const values = templateValues(['{"id":"a1","sender":{"name":"x"}}']);
    expect(values.id).toBe("a1");
    expect(values.sender).toBeUndefined();
  });

  test("行が無ければ件数 0", () => {
    expect(templateValues([]).count).toBe(0);
  });

  test("最後の行が JSON なら、その行の {line} も渡す", () => {
    const values = templateValues(['{"id":"a1"}']);
    expect(values.line).toBe('{"id":"a1"}');
  });
});

import { describe, expect, test } from "bun:test";
import { parseBdCreateJsonOutput, parseJsonLoose } from "./bd-json-parse";

describe("parseJsonLoose", () => {
  test("parses trimmed JSON object", () => {
    expect(parseJsonLoose('  {"a":1}  ')).toEqual({ a: 1 });
  });

  test("extracts object from noisy stdout", () => {
    const out = `level=info msg=start
{
  "id": "T-42",
  "title": "x"
}
trailing`;
    expect(parseJsonLoose(out)).toEqual({ id: "T-42", title: "x" });
  });

  test("extracts array when object missing", () => {
    const out = 'noise\n[{"id":"1"}]\n';
    const parsed = parseJsonLoose(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ id: "1" }]);
  });

  test("throws on empty", () => {
    expect(() => parseJsonLoose("   ")).toThrow("empty bd output");
  });

  test("parses object that contains an empty array (not as top-level [])", () => {
    const out = '{ "items": [], "ok": true }';
    expect(parseJsonLoose(out)).toEqual({ items: [], ok: true });
  });
});

describe("parseBdCreateJsonOutput", () => {
  test("returns object with id from pretty-printed create output", () => {
    const out = `Created issue.\n{\n  "id": "EPIC-7",\n  "title": "Epic"\n}\n`;
    expect(parseBdCreateJsonOutput(out)?.id).toBe("EPIC-7");
  });

  test("returns null when no id field", () => {
    expect(parseBdCreateJsonOutput('{"title":"only"}')).toBeNull();
  });

  test("returns null on garbage", () => {
    expect(parseBdCreateJsonOutput("no json here")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  test("returns the text between the two --- lines, and what follows the closing line", () => {
    expect(
      splitFrontmatter(
        '---\nargument-hint: "[task]"\n---\n# /go — Router\n\nBody.\n',
      ),
    ).toEqual({
      raw: 'argument-hint: "[task]"',
      body: "# /go — Router\n\nBody.\n",
    });
  });

  test("reads a file with CRLF line endings the same way", () => {
    expect(splitFrontmatter("---\r\na: 1\r\nb: 2\r\n---\r\n# H\r\n")).toEqual({
      raw: "a: 1\r\nb: 2",
      body: "# H\r\n",
    });
  });

  test("ignores a byte order mark before the opening line", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(splitFrontmatter(`${bom}---\na: 1\n---\n# H\n`)).toEqual({
      raw: "a: 1",
      body: "# H\n",
    });
  });

  test("a file that does not open with --- has no frontmatter, and its body is the whole file", () => {
    const text = "# /go — Router\n\n---\nnot: frontmatter\n---\n";
    expect(splitFrontmatter(text)).toEqual({ raw: null, body: text });
  });

  test("an opening --- with no closing line is not frontmatter", () => {
    const text = "---\na: 1\n\n# H\n";
    expect(splitFrontmatter(text)).toEqual({ raw: null, body: text });
  });

  test("a closing marker must stand alone on its line", () => {
    const text = "---\na: 1\n----\nb: 2\n---trailing\n# H\n";
    expect(splitFrontmatter(text)).toEqual({ raw: null, body: text });
  });

  test("an empty block is frontmatter with nothing in it", () => {
    expect(splitFrontmatter("---\n---\n# H\n")).toEqual({
      raw: "",
      body: "# H\n",
    });
  });

  test("stops at the first closing line, so a later --- stays in the body", () => {
    expect(
      splitFrontmatter("---\na: 1\n---\n# H\n\n---\n\nRule above.\n"),
    ).toEqual({ raw: "a: 1", body: "# H\n\n---\n\nRule above.\n" });
  });
});

import { expect, test } from "bun:test";
import { toNamespacedPath } from "node:path";
import { createWindowsConfigLeafKind } from "./transaction-windows";

test("native attribute inspection is lazy, fixed UTF-16 metadata and rejects every reparse tag or unknown result", () => {
  let loaded = 0;
  let flags = 0x80;
  const paths: Buffer[] = [];
  const inspect = createWindowsConfigLeafKind(() => {
    loaded++;
    return {
      GetFileAttributesW(path) {
        paths.push(Buffer.from(path));
        return flags;
      },
    };
  });
  expect(loaded).toBe(0);
  const file = "C:\\captured\\config.toml";
  expect(inspect(file)).toBe("plain");
  expect(paths[0]?.toString("utf16le")).toBe(`${toNamespacedPath(file)}\0`);
  flags = 0x420;
  expect(inspect(file)).toBe("reparse");
  for (const invalid of [0xffffffff, -1, NaN, 1.5, 0x1_0000_0000]) {
    flags = invalid;
    expect(inspect(file)).toBe("unknown");
  }
  expect(loaded).toBe(1);
  expect(
    createWindowsConfigLeafKind(() => {
      throw Error("unavailable");
    })(file),
  ).toBe("unknown");
});

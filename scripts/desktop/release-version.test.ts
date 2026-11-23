import { expect, test } from "bun:test";
import { compareReleaseVersions } from "./release-version";

test("the bundled release candidate sorts below the corresponding stable release", () => {
  expect(compareReleaseVersions("1.0.0-rc.1", "v1.0.0")).toBe(-1);
});
test.each([
  ["1.9.0", "1.10.0", -1],
  ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
  ["1.0.0-1", "1.0.0-alpha", -1],
  ["1.0.0-rc.2", "1.0.0-rc.10", -1],
  ["1.0.0+build.1", "1.0.0+build.2", 0],
  ["99999999999999999.0.0", "100000000000000000.0.0", -1],
  ["01.0.0", "1.0.0", null],
  ["1.0.0-01", "1.0.0", null],
  ["1.0.0\n", "1.0.0", null],
  ["1.0", "1.0.0", null],
])("SemVer precedence %s vs %s", (left, right, order) => {
  expect(compareReleaseVersions(String(left), String(right))).toBe(
    order as number | null,
  );
});

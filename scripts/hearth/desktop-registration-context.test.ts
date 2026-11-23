import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createDesktopRegistrationContext } from "./desktop-registration-context";

const options = () => {
  const nativeApp = resolve("fixture assets", "desktop.exe");
  return {
    root: resolve("fixture root"),
    home: resolve("fixture state"),
    hearthCommand: [
      resolve("fixture assets", "hearth.exe"),
      "--native-project-picker",
      nativeApp,
    ],
    nativeApp,
  };
};
test("private registration descriptor binds the exact compiled asset, selected root and actual home", () => {
  const input = options();
  const command = input.hearthCommand[0];
  if (!command) throw Error("Missing fixture command");
  const value = createDesktopRegistrationContext(input);
  expect(value).toEqual({
    version: 1,
    root: input.root,
    home: input.home,
    command,
    args: ["--mcp-stdio", "--root", input.root, "--home", input.home],
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value?.args)).toBe(true);
  input.hearthCommand[0] = resolve("changed.exe");
  expect(value?.command).not.toBe(input.hearthCommand[0]);
});
test("source/default or foreign native command shapes never become a packaged registration", () => {
  const input = options();
  expect(
    createDesktopRegistrationContext({ root: input.root, home: input.home }),
  ).toBeNull();
  for (const command of [
    [],
    [input.hearthCommand[0] ?? ""],
    [input.hearthCommand[0] ?? "", "--operator", input.nativeApp],
    [...input.hearthCommand, "--operator"],
    [
      input.hearthCommand[0] ?? "",
      "--native-project-picker",
      resolve("foreign.exe"),
    ],
  ]) {
    expect(
      createDesktopRegistrationContext({ ...input, hearthCommand: command }),
    ).toBeNull();
  }
});
test("relative, control-bearing or oversized private selectors remain unavailable", () => {
  for (const key of ["root", "home", "nativeApp"] as const) {
    for (const value of [
      "relative",
      "",
      "x".repeat(1025),
      resolve("bad\nselector"),
    ]) {
      expect(
        createDesktopRegistrationContext({ ...options(), [key]: value }),
      ).toBeNull();
    }
  }
  const input = options();
  expect(
    createDesktopRegistrationContext({
      ...input,
      hearthCommand: [
        "relative.exe",
        "--native-project-picker",
        input.nativeApp,
      ],
    }),
  ).toBeNull();
});

test("serialized private descriptors fit the unchanged native ready envelope", () => {
  const input = options();
  const long = resolve("x".repeat(650));
  expect(
    createDesktopRegistrationContext({ ...input, root: long, home: long }),
  ).toBeNull();
  const value = createDesktopRegistrationContext(input);
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(
    2048,
  );
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { desktopWorktreeHomeLayout } from "../../tests/desktop-worktree-e2e/home-layout";

test("the Git fixture config home stays under the fixture while server OS home stays separate", () => {
  const fixtureRoot = "C:/owned/fixture",
    serverOsHome = "C:/owned/server-os-home",
    layout = desktopWorktreeHomeLayout(fixtureRoot, serverOsHome);

  expect(layout).toEqual({
    gitHome: join(fixtureRoot, "empty-home"),
    serverOsHome,
  });
  expect(layout.gitHome).not.toBe(layout.serverOsHome);
  expect(() =>
    desktopWorktreeHomeLayout(fixtureRoot, "C:/owned/fixture/empty-home"),
  ).toThrow("The Git fixture home must differ from the server OS home.");
});

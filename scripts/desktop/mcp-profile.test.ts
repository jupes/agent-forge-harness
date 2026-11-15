import { expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";

test("pinned Bun profile semantics require an independent native profile source", () => {
  const before = userInfo().homedir;
  const profile = process.env.USERPROFILE;
  const home = process.env.HOME;
  const fixture = resolve(".tmp", "not-created-mcp-profile-fixture");
  try {
    process.env.USERPROFILE = fixture;
    process.env.HOME = fixture;
    expect(homedir()).toBe(fixture);
    // Bun1.4.2 Windows uses USERPROFILE even for userInfo(). It is not an
    // OS-user identity anchor. This test reads no client file and creates none.
    expect(userInfo().homedir).toBe(
      process.platform === "win32" ? fixture : before,
    );
  } finally {
    if (profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = profile;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
  expect(userInfo().homedir).toBe(before);
});

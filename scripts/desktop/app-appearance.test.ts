import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAppAppearanceClient } from "../../apps/desktop/src/app-appearance-client";
import { writeOwnerOnly } from "../hearth/token";
import {
  appAppearanceWriteSchema,
  effectiveAppTheme,
} from "../projects/app-appearance-protocol";
import {
  appAppearanceSettingsPath,
  createAppAppearanceStore,
} from "../projects/app-appearance-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!basename(root).startsWith("forge-appearance-"))
      throw Error("Unexpected fixture root");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-appearance-"));
  roots.push(root);
  const home = join(root, "home");
  return { home, store: createAppAppearanceStore(home) };
}
test("appearance defaults to dark compact and survives reopen without stale overwrites", async () => {
  const { home, store } = fixture();
  expect(store.read()).toMatchObject({
    revision: 0,
    source: "default",
    appearance: { theme: "dark", density: "compact" },
  });
  const saved = await store.write({
    expectedRevision: 0,
    appearance: { theme: "system", density: "comfortable" },
  });
  expect(saved.revision).toBe(1);
  expect(createAppAppearanceStore(home).read()).toEqual(saved);
  const bytes = readFileSync(appAppearanceSettingsPath(home), "utf8");
  await expect(
    store.write({
      expectedRevision: 0,
      appearance: { theme: "light", density: "compact" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(appAppearanceSettingsPath(home), "utf8")).toBe(bytes);
});
test("appearance client retains a lost-save draft and fences duplicates until a newer CAS revision", async () => {
  let value = {
    version: 1,
    revision: 0,
    source: "default",
    appearance: { theme: "dark", density: "compact" },
  };
  let posts = 0;
  const client = createAppAppearanceClient({
    read: async () => value,
    post: async () => {
      posts++;
      throw Error("Lost response");
    },
    canWrite: () => true,
    changed() {},
  });
  await client.check();
  client.edit({ theme: "light", density: "comfortable" });
  await client.save();
  await client.save();
  await client.check();
  expect(posts).toBe(1);
  expect(client.state.unknownRevision).toBe(0);
  expect(client.state.draft).toEqual({
    theme: "light",
    density: "comfortable",
  });
  value = {
    version: 1,
    revision: 1,
    source: "machine",
    appearance: { theme: "light", density: "comfortable" },
  };
  await client.check();
  expect(client.state.unknownRevision).toBeNull();
  expect(client.state.draft?.theme).toBe("light");
});
test("appearance saves confirm exact readback, palette cycles the same store, and drafts block palette writes", async () => {
  const { store } = fixture();
  let posts = 0;
  const client = createAppAppearanceClient({
    read: async () => store.read(),
    post: async (body) => {
      posts++;
      return Response.json({
        ok: true,
        data: await store.write(body),
        error: null,
      });
    },
    canWrite: () => true,
    changed() {},
  });
  await client.check();
  await client.toggleTheme();
  expect(store.read().appearance.theme).toBe("light");
  expect(client.state.draft).toBeNull();
  expect(client.state.unknownRevision).toBeNull();
  await client.toggleTheme();
  expect(store.read().appearance.theme).toBe("system");
  client.edit({ theme: "dark", density: "comfortable" });
  await client.toggleTheme();
  expect(posts).toBe(2);
  await client.save();
  expect(posts).toBe(3);
  expect(store.read()).toMatchObject({
    revision: 3,
    appearance: { theme: "dark", density: "comfortable" },
  });
});
test("failed or contradictory reads hold writes and preserve the last verified appearance", async () => {
  let raw: unknown = {
    version: 1,
    revision: 1,
    source: "machine",
    appearance: { theme: "light", density: "compact" },
  };
  let posts = 0;
  const client = createAppAppearanceClient({
    read: async () => raw,
    post: async () => {
      posts++;
      throw Error("unexpected");
    },
    canWrite: () => true,
    changed() {},
  });
  await client.check();
  client.edit({ theme: "system", density: "compact" });
  raw = {
    version: 1,
    revision: 1,
    source: "machine",
    appearance: { theme: "dark", density: "compact" },
  };
  await client.check();
  expect(client.state.verified).toBe(false);
  expect(client.state.current?.appearance.theme).toBe("light");
  await client.save();
  expect(posts).toBe(0);
  raw = {
    version: 1,
    revision: 2,
    source: "machine",
    appearance: { theme: "dark", density: "compact" },
  };
  await client.check();
  expect(client.state.verified).toBe(true);
  expect(client.state.draft?.theme).toBe("system");
});
test("malformed saved appearance and missing initialized files never silently become defaults", async () => {
  for (const invalid of [
    "{",
    JSON.stringify({
      version: 1,
      revision: 0,
      source: "default",
      appearance: { theme: "dark", density: "compact" },
    }),
    null,
  ]) {
    const { home, store } = fixture();
    await store.write({
      expectedRevision: 0,
      appearance: { theme: "light", density: "compact" },
    });
    if (invalid === null) rmSync(appAppearanceSettingsPath(home));
    else writeOwnerOnly(appAppearanceSettingsPath(home), invalid);
    expect(() => store.read()).toThrow();
    await expect(
      store.write({
        expectedRevision: 1,
        appearance: { theme: "dark", density: "compact" },
      }),
    ).rejects.toMatchObject({ status: 503 });
  }
});
test("appearance schema refuses extra authority and invalid values; system resolves from current preference", () => {
  for (const appearance of [
    { theme: "sepia", density: "compact" },
    { theme: "dark", density: "tiny" },
    { theme: "dark", density: "compact", path: "foreign" },
  ])
    expect(
      appAppearanceWriteSchema.safeParse({ expectedRevision: 0, appearance })
        .success,
    ).toBe(false);
  expect(effectiveAppTheme({ theme: "system", density: "compact" }, true)).toBe(
    "light",
  );
  expect(
    effectiveAppTheme({ theme: "system", density: "compact" }, false),
  ).toBe("dark");
  expect(effectiveAppTheme({ theme: "dark", density: "compact" }, true)).toBe(
    "dark",
  );
});
test("appearance CAS serializes simultaneous windows without a lost update", async () => {
  const { home, store } = fixture();
  const results = await Promise.allSettled([
    store.write({
      expectedRevision: 0,
      appearance: { theme: "light", density: "compact" },
    }),
    createAppAppearanceStore(home).write({
      expectedRevision: 0,
      appearance: { theme: "dark", density: "comfortable" },
    }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(store.read().revision).toBe(1);
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../../package.json";

test("bundled renderer release metadata agrees with Tauri and Cargo package versions", () => {
  const root = join(import.meta.dir, "../..");
  let tauri: unknown;
  try {
    tauri = JSON.parse(
      readFileSync(
        join(root, "apps/desktop/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    );
  } catch {
    throw Error("Tauri release metadata is invalid");
  }
  expect(tauri).toMatchObject({ version });
  expect(
    Bun.TOML.parse(
      readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8"),
    ),
  ).toMatchObject({ package: { name: "agent-forge-desktop", version } });
});

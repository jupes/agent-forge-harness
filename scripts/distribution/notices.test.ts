import { build } from "vite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const noticeFiles = [
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  [".claude/skills/ATTRIBUTION.md", ".claude/skills/ATTRIBUTION.md"],
  ["docs/fonts/LICENSE-Inter.txt", "docs/fonts/LICENSE-Inter.txt"],
] as const;

test("dashboard build emits the project and source attribution notices", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-forge-notices-"));
  const previousNoBuild = process.env.DASHBOARD_NO_BUILD;
  process.env.DASHBOARD_NO_BUILD = "1";
  try {
    await build({
      configFile: resolve(repositoryRoot, "vite.dashboard.config.ts"),
      mode: "desktop",
      logLevel: "silent",
      build: { outDir: outputRoot, emptyOutDir: true },
    });
    for (const [sourcePath, artifactPath] of noticeFiles) {
      const artifact = join(outputRoot, artifactPath);
      expect(existsSync(artifact)).toBe(true);
      expect(readFileSync(artifact)).toEqual(
        readFileSync(join(repositoryRoot, sourcePath)),
      );
    }
  } finally {
    if (previousNoBuild === undefined) delete process.env.DASHBOARD_NO_BUILD;
    else process.env.DASHBOARD_NO_BUILD = previousNoBuild;
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

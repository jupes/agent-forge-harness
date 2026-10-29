import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { readDistributionNotices, writeDistributionNotices } from "./notices";

const repositoryRoot = resolve(import.meta.dir, "../..");
const noticeFiles = [
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  [".claude/skills/ATTRIBUTION.md", ".claude/skills/ATTRIBUTION.md"],
  ["docs/fonts/LICENSE-Inter.txt", "docs/fonts/LICENSE-Inter.txt"],
  [
    "scripts/distribution/THIRD-PARTY-NOTICES.txt",
    "THIRD-PARTY-NOTICES.txt",
  ],
] as const;

function expectArtifactMap(stageRoot: string): void {
  const map = readFileSync(join(stageRoot, "DISTRIBUTION-NOTICES.txt"), "utf8");
  expect(map).toContain("LICENSE <- LICENSE");
  expect(map).toContain("NOTICE <- NOTICE");
  expect(map).toContain(
    "docs/fonts/LICENSE-Inter.txt <- docs/fonts/LICENSE-Inter.txt",
  );
  expect(map).toContain("Phosphor glyph data from docs/js/ds/icon-paths.ts");
  expect(map).toContain(
    ".claude/skills/tdd/SKILL.md and .agents/skills/tdd/SKILL.md",
  );
  expect(map).toContain("no skill code is bundled");
}

test("desktop and production dashboard builds emit distribution notices", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-forge-notices-"));
  const previousNoBuild = process.env.DASHBOARD_NO_BUILD;
  process.env.DASHBOARD_NO_BUILD = "1";
  try {
    for (const mode of ["desktop", "production"] as const) {
      await build({
        configFile: resolve(repositoryRoot, "vite.dashboard.config.ts"),
        mode,
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
      expectArtifactMap(outputRoot);
    }
  } finally {
    if (previousNoBuild === undefined) delete process.env.DASHBOARD_NO_BUILD;
    else process.env.DASHBOARD_NO_BUILD = previousNoBuild;
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("desktop stage writer copies the same validated notice bytes", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-forge-stage-notices-"));
  const stageRoot = join(outputRoot, "stage");
  try {
    const notices = readDistributionNotices(repositoryRoot);
    writeDistributionNotices(stageRoot, notices);
    for (const [sourcePath, artifactPath] of noticeFiles) {
      expect(readFileSync(join(stageRoot, artifactPath))).toEqual(
        readFileSync(join(repositoryRoot, sourcePath)),
      );
    }
    expectArtifactMap(stageRoot);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("missing notice input refuses before replacing staged notices", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-forge-missing-notice-"));
  const fixtureRoot = join(outputRoot, "repo");
  const stageRoot = join(outputRoot, "stage");
  try {
    for (const [sourcePath] of noticeFiles) {
      const target = join(fixtureRoot, sourcePath);
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(join(repositoryRoot, sourcePath), target);
    }
    mkdirSync(stageRoot);
    writeFileSync(join(stageRoot, "LICENSE"), "previous license");
    writeFileSync(join(stageRoot, "NOTICE"), "previous notice");
    rmSync(join(fixtureRoot, "NOTICE"));

    expect(() => {
      const notices = readDistributionNotices(fixtureRoot);
      writeDistributionNotices(stageRoot, notices);
    }).toThrow();
    expect(readFileSync(join(stageRoot, "LICENSE"), "utf8")).toBe(
      "previous license",
    );
    expect(readFileSync(join(stageRoot, "NOTICE"), "utf8")).toBe(
      "previous notice",
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

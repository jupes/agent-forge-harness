import { build } from "vite";
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
import {
  readDistributionNotices,
  writeDistributionNotices,
} from "./notices";

const repositoryRoot = resolve(import.meta.dir, "../..");
const noticeFiles = [
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  [".claude/skills/ATTRIBUTION.md", ".claude/skills/ATTRIBUTION.md"],
  ["docs/fonts/LICENSE-Inter.txt", "docs/fonts/LICENSE-Inter.txt"],
] as const;
const artifactMap =
  "Copied legal and attribution documents:\n" +
  "LICENSE <- LICENSE\nNOTICE <- NOTICE\n" +
  ".claude/skills/ATTRIBUTION.md <- .claude/skills/ATTRIBUTION.md " +
  "(attribution only; skill implementations are not bundled)\n" +
  "docs/fonts/LICENSE-Inter.txt <- docs/fonts/LICENSE-Inter.txt\n" +
  ".agents/skills/tdd/SKILL.md is a repository-only linked source, " +
  "not bundled as skill code.\n";

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
    expect(readFileSync(join(outputRoot, "DISTRIBUTION-NOTICES.txt"), "utf8"))
      .toBe(artifactMap);
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
    expect(readFileSync(join(stageRoot, "DISTRIBUTION-NOTICES.txt"), "utf8"))
      .toBe(artifactMap);
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

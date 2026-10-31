import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";
import { readDistributionNotices, writeDistributionNotices } from "./notices";

const repositoryRoot = resolve(import.meta.dir, "../..");
const maxPackageManifestBytes = 64 * 1024;
const maxLicenseNoticeBytes = 1024 * 1024;
const noticeFiles = [
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  [".claude/skills/ATTRIBUTION.md", ".claude/skills/ATTRIBUTION.md"],
  ["docs/fonts/LICENSE-Inter.txt", "docs/fonts/LICENSE-Inter.txt"],
  ["scripts/distribution/THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
] as const;
const thirdPartyPackages = [
  { name: "preact", version: "10.29.1", license: "LICENSE" },
  { name: "zod", version: "4.5.4", license: "LICENSE" },
  { name: "chart.js", version: "4.4.7", license: "LICENSE.md" },
  { name: "chartjs-chart-matrix", version: "2.0.1", license: "LICENSE" },
  { name: "@kurkle/color", version: "0.3.4", license: "LICENSE.md" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedText(
  path: string,
  maxBytes: number,
  label: string,
): string {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maxBytes) throw new Error();
    const contents = readFileSync(path);
    if (contents.length > maxBytes) throw new Error();
    return contents.toString("utf8");
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function readInstalledPackageManifest(
  manifestPath: string,
  packageName: string,
): Record<string, unknown> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readBoundedText(
        manifestPath,
        maxPackageManifestBytes,
        "package manifest",
      ),
    );
  } catch {
    throw new Error(`Invalid installed package manifest: ${packageName}`);
  }
  if (!isRecord(manifest) || manifest.name !== packageName) {
    throw new Error(`Invalid installed package manifest: ${packageName}`);
  }
  return manifest;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function findInstalledPackageRoot(packageName: string): string {
  let current = dirname(Bun.resolveSync(packageName, repositoryRoot));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      readInstalledPackageManifest(join(current, "package.json"), packageName);
      return current;
    } catch {
      // Continue the bounded search for the matching package manifest.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Could not locate installed package metadata: ${packageName}`,
  );
}

function expectArtifactMap(stageRoot: string): void {
  const map = readFileSync(join(stageRoot, "DISTRIBUTION-NOTICES.txt"), "utf8");
  expect(map).toContain("LICENSE <- LICENSE");
  expect(map).toContain("NOTICE <- NOTICE");
  expect(map).toContain(
    "docs/fonts/LICENSE-Inter.txt <- docs/fonts/LICENSE-Inter.txt",
  );
  expect(map).toContain(
    "THIRD-PARTY-NOTICES.txt <- " +
      "scripts/distribution/THIRD-PARTY-NOTICES.txt",
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

test("selected browser package versions and full MIT texts match the notice", () => {
  const notice = readBoundedText(
    join(repositoryRoot, "scripts/distribution/THIRD-PARTY-NOTICES.txt"),
    maxLicenseNoticeBytes,
    "third-party notice",
  );
  for (const packageInfo of thirdPartyPackages) {
    const packageRoot = findInstalledPackageRoot(packageInfo.name);
    const manifest = readInstalledPackageManifest(
      join(packageRoot, "package.json"),
      packageInfo.name,
    );
    expect(manifest.version).toBe(packageInfo.version);
    expect(manifest.license).toBe("MIT");
    expect(notice).toContain(
      `Package: ${packageInfo.name} ${packageInfo.version}`,
    );
    expect(normalizeNewlines(notice)).toContain(
      normalizeNewlines(
        readBoundedText(
          join(packageRoot, packageInfo.license),
          maxLicenseNoticeBytes,
          "package license",
        ),
      ),
    );
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

function expectMissingNoticeToPreserveStage(missingSource: string): void {
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
    rmSync(join(fixtureRoot, missingSource));

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
}

test("missing notice inputs refuse before replacing staged notices", () => {
  expectMissingNoticeToPreserveStage("NOTICE");
  expectMissingNoticeToPreserveStage(
    "scripts/distribution/THIRD-PARTY-NOTICES.txt",
  );
});

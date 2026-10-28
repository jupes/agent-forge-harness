import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const noticeSources = [
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  [".claude/skills/ATTRIBUTION.md", ".claude/skills/ATTRIBUTION.md"],
  ["docs/fonts/LICENSE-Inter.txt", "docs/fonts/LICENSE-Inter.txt"],
] as const;
type NoticeSource = (typeof noticeSources)[number][0];
export type DistributionNoticeSnapshot = ReadonlyMap<NoticeSource, Uint8Array>;
const maxNoticeBytes = 1024 * 1024;
const artifactMapPath = "DISTRIBUTION-NOTICES.txt";
const artifactMap = Buffer.from(
  "Copied legal and attribution documents:\n" +
    "LICENSE <- LICENSE\nNOTICE <- NOTICE\n" +
    ".claude/skills/ATTRIBUTION.md <- .claude/skills/ATTRIBUTION.md " +
    "(attribution only; skill implementations are not bundled)\n" +
    "docs/fonts/LICENSE-Inter.txt <- docs/fonts/LICENSE-Inter.txt\n" +
    "Phosphor glyph data from docs/js/ds/icon-paths.ts is in generated " +
    "dashboard JavaScript; that source file is not copied.\n" +
    ".claude/skills/tdd/SKILL.md and .agents/skills/tdd/SKILL.md are " +
    "repository-only references; no skill code is bundled.\n",
);

export function readDistributionNotices(
  repositoryRoot: string,
): DistributionNoticeSnapshot {
  const notices = new Map<NoticeSource, Uint8Array>();
  for (const [source] of noticeSources) {
    const sourcePath = join(repositoryRoot, source);
    const stats = lstatSync(sourcePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxNoticeBytes) {
      throw new Error(`Invalid distribution notice source: ${source}`);
    }
    const contents = readFileSync(sourcePath);
    if (contents.length === 0 || contents.length > maxNoticeBytes) {
      throw new Error(`Invalid distribution notice source: ${source}`);
    }
    notices.set(source, contents);
  }
  return notices;
}

function noticeOutputs(
  notices: DistributionNoticeSnapshot,
): readonly (readonly [string, Uint8Array])[] {
  const outputs = noticeSources.map(([source, artifact]) => {
    const contents = notices.get(source);
    if (!contents) throw new Error(`Missing distribution notice: ${source}`);
    return [artifact, contents] as const;
  });
  return [...outputs, [artifactMapPath, artifactMap] as const];
}

export function distributionNoticesPlugin(repositoryRoot: string): Plugin {
  let notices: DistributionNoticeSnapshot | undefined;
  return {
    name: "agent-forge-distribution-notices",
    apply: "build",
    buildStart() {
      notices = readDistributionNotices(repositoryRoot);
    },
    generateBundle() {
      if (!notices) throw new Error("Distribution notices were not preflighted");
      for (const [fileName, source] of noticeOutputs(notices)) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}

export function writeDistributionNotices(
  stageRoot: string,
  notices: DistributionNoticeSnapshot,
): void {
  const outputs = noticeOutputs(notices);
  for (const [fileName, contents] of outputs) {
    const outputPath = join(stageRoot, fileName);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, contents);
  }
}

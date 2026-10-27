import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Plant only an inert local script for tests of the real codex:sync boundary. */
export function plantInertCodexSyncFixture(workspace: string): void {
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({
      name: "private-codex-sync-fixture",
      private: true,
      scripts: { "codex:sync": "bun mark-codex-synced.ts" },
    })}\n`,
    { flag: "wx" },
  );
  writeFileSync(
    join(workspace, "mark-codex-synced.ts"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync("codex-sync-fixture-marker.txt", "inert sync ran\\n");\n',
    { flag: "wx" },
  );
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "../executors/env";
import { supervise } from "../executors/supervisor";
import { ensurePrivateHome } from "../hearth/home-guard";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "./registry";

/** Packaged smoke oracle: only a disposable private original, no CLI, tracker, remote or credential. */
export async function verifyProjectShiftEntry(
  command: readonly string[],
): Promise<void> {
  const scratch = scratchDirs(),
    root = scratch.make("project-shift-entry-smoke-"),
    home = join(root, "home");
  try {
    mkdirSync(join(root, ".git"));
    ensurePrivateHome(home);
    const registry = createProjectShiftRegistry({ root, home }),
      requestId = "b14cc7eb-3231-4930-a288-d411c5ee0426";
    const saved = await registry.reserve(
      FIXTURE_PROJECT_ID,
      {
        requestId,
        expectedCatalogRevision: 1,
        options: {
          for: "2h",
          concurrency: 2,
          maxBeads: 4,
          maxUsd: 10,
          repairs: 3,
          base: "master",
        },
      },
      async () => ({ shiftId: "shift-20261023-063000-0001" }),
    );
    await registry.markAttempted(
      FIXTURE_PROJECT_ID,
      requestId,
      saved.intent.requestHash,
    );
    const file = projectShiftRegistryFile(home),
      before = readFileSync(file, "utf8");
    let stdout = "",
      valid = true;
    const child = supervise({
      command: [
        ...command,
        "--project-shift-run",
        FIXTURE_PROJECT_ID,
        requestId,
      ],
      cwd: root,
      env: {
        ...buildChildEnv(process.env, []),
        HOME: root,
        USERPROFILE: root,
        AGENT_FORGE_HOME: home,
      },
      stdin: "",
      timeoutMs: 10_000,
      maxLineBytes: 16_384,
      onLine(line) {
        if (stdout.length + line.length > 16_384) {
          valid = false;
          return;
        }
        stdout += line;
      },
      onOutputError() {
        valid = false;
      },
    });
    const result = await child.done;
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw Error(
        "Packaged shift entry returned no verified refusal envelope.",
      );
    }
    if (
      !valid ||
      result.exitCode !== 1 ||
      result.timedOut ||
      result.stopped ||
      !envelope ||
      typeof envelope !== "object" ||
      !("ok" in envelope) ||
      envelope.ok !== false ||
      !("data" in envelope) ||
      envelope.data !== null ||
      readFileSync(file, "utf8") !== before ||
      existsSync(join(home, "shifts"))
    )
      throw Error(
        "Packaged shift entry did not preserve its unavailable attended boundary.",
      );
  } finally {
    scratch.cleanup();
  }
}

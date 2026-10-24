import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "../executors/env";
import { supervise } from "../executors/supervisor";
import { ensurePrivateHome } from "../hearth/home-guard";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import { projectShiftReceiptSchema } from "./protocol";
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
      authorized = registry.read(FIXTURE_PROJECT_ID, requestId);
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
    const diagnostic = JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stopped: result.stopped,
      stdout: stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
    });
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw Error(
        `Packaged shift entry returned no verified refusal envelope: ${diagnostic}`,
      );
    }
    if (
      !valid ||
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stopped ||
      !envelope ||
      typeof envelope !== "object" ||
      !("ok" in envelope) ||
      envelope.ok !== true ||
      !("data" in envelope) ||
      existsSync(join(home, "shifts"))
    )
      throw Error(
        `Packaged shift entry did not preserve its closed original-id boundary: ${diagnostic}`,
      );
    const original = registry.read(FIXTURE_PROJECT_ID, requestId),
      receipt = projectShiftReceiptSchema.safeParse(envelope.data);
    if (
      !original.executionStartedAt ||
      JSON.stringify({
        ...original,
        executionStartedAt: authorized.executionStartedAt,
      }) !== JSON.stringify(authorized) ||
      !receipt.success ||
      JSON.stringify(receipt.data.intent) !== JSON.stringify(original) ||
      receipt.data.observation.phase !== "unknown"
    )
      throw Error(
        "The packaged original claim or unknown receipt could not be verified.",
      );
    // Claiming an already authorized original may consume its one engine entry.
    // Its bounds stay immutable, and a repeated child command is observation only.
    const after = readFileSync(file, "utf8");
    const repeated = Bun.spawnSync(
      [...command, "--project-shift-run", FIXTURE_PROJECT_ID, requestId],
      {
        cwd: root,
        env: {
          ...buildChildEnv(process.env, []),
          HOME: root,
          USERPROFILE: root,
          AGENT_FORGE_HOME: home,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    let second: unknown;
    try {
      second = JSON.parse(repeated.stdout.toString());
    } catch {
      throw Error("The packaged observation did not return one receipt.");
    }
    if (
      repeated.exitCode !== 0 ||
      repeated.stderr.toString() !== "" ||
      !second ||
      typeof second !== "object" ||
      !("ok" in second) ||
      second.ok !== true ||
      readFileSync(file, "utf8") !== after ||
      existsSync(join(home, "shifts"))
    )
      throw Error(
        "The packaged original was repeated or changed during observation.",
      );
  } finally {
    scratch.cleanup();
  }
}

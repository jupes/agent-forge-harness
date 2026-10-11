import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunPath, HEARTH_HOME, standInEnvironment } from "./servers";

/**
 * A throwaway forge run for `live-stream.spec.ts`, written by the real
 * `scripts/forge/phase-gate.ts`.
 *
 * The command works in the checkout: the hearth the suite started reads run
 * state from there, and the event's workspace is derived from it. So the run
 * has a slug of a shape no real run has, its three files are removed by the
 * test that made them, and teardown sweeps whatever a killed test left.
 * Its ledger events go to the suite's own home, which is deleted with it.
 */

const LIVE_SLUG = /^e2e-live-\d+-\d+-\d+$/;

let made = 0;

/** A slug no real run has: this process, this moment, a counter. */
export function newLiveSlug(): string {
  made += 1;
  return `e2e-live-${process.pid}-${Date.now()}-${made}`;
}

export type LivePhase = "research" | "plan";

const ARTIFACT_DIR: Record<LivePhase, string> = {
  research: join("plans", "research"),
  plan: join("plans", "drafts"),
};
const STATE_DIR = join(".tmp", "work", "forge-runs");
/** A run from before state went per run. The command would move it; see `writePhase`. */
const LEGACY_STATE = join(".tmp", "work", "forge-state.json");

/** Every file a throwaway run can leave, relative to the checkout. All are gitignored paths. */
export function liveRunFiles(slug: string): string[] {
  return [
    join(ARTIFACT_DIR.research, `${slug}.md`),
    join(ARTIFACT_DIR.plan, `${slug}.md`),
    join(STATE_DIR, `${slug}.json`),
  ];
}

export function removeLiveRun(
  slug: string,
  root: string = process.cwd(),
): void {
  if (!LIVE_SLUG.test(slug)) throw new Error(`not a throwaway slug: ${slug}`);
  for (const file of liveRunFiles(slug))
    rmSync(join(root, file), { force: true });
}

/** Remove what any throwaway run left behind. Only names of the generated shape are touched. */
export function sweepLiveRuns(root: string = process.cwd()): void {
  for (const [directory, extension] of [
    [ARTIFACT_DIR.research, ".md"],
    [ARTIFACT_DIR.plan, ".md"],
    [STATE_DIR, ".json"],
  ] as const) {
    let names: string[];
    try {
      names = readdirSync(join(root, directory));
    } catch {
      continue;
    }
    for (const name of names)
      if (
        name.endsWith(extension) &&
        LIVE_SLUG.test(name.slice(0, -extension.length))
      )
        rmSync(join(root, directory, name), { force: true });
  }
}

/**
 * The environment of the suite's hearth, so the command names the same
 * workspace and writes to the same ledger, and nothing that would tie the
 * throwaway run to a real bead, run or session of the developer's.
 */
function commandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.toUpperCase().startsWith("AGENT_FORGE_"))
      environment[name] = value;
  return {
    ...environment,
    ...standInEnvironment(),
    AGENT_FORGE_HOME: HEARTH_HOME,
  };
}

/**
 * Record `phase` complete for a throwaway run with the real command:
 * `bun scripts/forge/phase-gate.ts <phase> --slug <slug> --write`.
 * It writes the run's state file, then appends one `run.phase.completed`
 * event to the suite's ledger. No bead is named, so no run correlation is written.
 */
export async function writePhase(
  slug: string,
  phase: LivePhase,
): Promise<void> {
  if (!LIVE_SLUG.test(slug)) throw new Error(`not a throwaway slug: ${slug}`);
  // An empty home means the developer's real one to the ledger.
  if (!HEARTH_HOME)
    throw new Error("the suite has no home of its own: refusing to write");
  // The command moves a legacy run into the runs directory before anything
  // else. That is a real run's state; this test must not be what moves it.
  if (existsSync(LEGACY_STATE))
    throw new Error(
      `${LEGACY_STATE} holds a run from before state went per run. Run any forge:phase-gate command once to migrate it, then run the suite again.`,
    );
  // The command refuses to complete a phase whose artifact is missing.
  writeFileSync(
    join(ARTIFACT_DIR[phase], `${slug}.md`),
    `# ${slug}\n\nWritten by the browser suite; safe to delete.\n`,
  );
  await new Promise<void>((done, fail) => {
    const child = spawn(
      bunPath(),
      [
        join("scripts", "forge", "phase-gate.ts"),
        phase,
        "--slug",
        slug,
        "--write",
      ],
      { env: commandEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done()
        : fail(
            new Error(`phase-gate exited ${code}: ${output.slice(0, 2000)}`),
          ),
    );
  });
}

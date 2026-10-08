import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ForgeState } from "./phases";
import { parseState } from "./runs";

const HOOK = join(
  import.meta.dir,
  "..",
  "..",
  ".claude",
  "hooks",
  "forge-phase-gate.ts",
);
const AT = "2026-06-04T00:00:00.000Z";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A scratch checkout holding one run's state file, under a path with a space. */
function checkoutWith(state: ForgeState): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), "stop hook test "));
  temporary.push(cwd);
  const dir = join(cwd, ".tmp", "work", "forge-runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${state.slug}.json`);
  writeFileSync(file, JSON.stringify(state));
  return { cwd, file };
}

async function stopHook(cwd: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  const child = Bun.spawn(["bun", "run", HOOK], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return stdout.trim();
}

describe("the Stop hook script, run against a scratch run file", () => {
  test("a halt that lands after the phase was announced is printed once, and the run file keeps its rounds", async () => {
    const reviews: ForgeState["reviews"] = [
      {
        phase: "research",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 0, low: 0 },
        at: AT,
      },
      {
        phase: "research",
        round: 2,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 0, low: 0 },
        at: AT,
      },
    ];
    const { cwd, file } = checkoutWith({
      slug: "demo",
      phase: "research",
      completed: ["research"],
      artifacts: {},
      mode: "auto",
      announcedPhase: "research",
      announcedStatus: "awaiting-review",
      reviews,
      updatedAt: AT,
    });

    const first = await stopHook(cwd);
    expect(first).toContain('Run "demo" (auto)');
    expect(first).toContain("HALTED in research");
    expect(first).not.toContain("/forge-plan");

    const after = parseState(readFileSync(file, "utf8"));
    expect(after?.announcedStatus).toBe("halted");
    expect(after?.reviews).toEqual(reviews);

    expect(await stopHook(cwd)).toBe("");
  }, 60_000);

  test("a gated run is told its next phase command once", async () => {
    const { cwd } = checkoutWith({
      slug: "demo",
      phase: "research",
      completed: ["research"],
      artifacts: {},
      updatedAt: AT,
    });
    expect(await stopHook(cwd)).toContain("Next: /forge-plan demo");
    expect(await stopHook(cwd)).toBe("");
  }, 60_000);
});

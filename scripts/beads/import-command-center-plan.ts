/**
 * Import or re-sync the Agent Forge Command Center bead graph.
 *
 *   bun run beads:import-command-center-plan            # create missing issues/deps (idempotent)
 *   bun run beads:import-command-center-plan --sync     # also push title/description/AC/priority edits
 *   bun run beads:import-command-center-plan --dry-run  # validate + print order, no bd calls
 *   bun run beads:import-command-center-plan --markdown # print the bead map table for docs
 *
 * Known ids are persisted in scripts/beads/command-center-plan.ids.json so that
 * titles may change in the plan without creating duplicates.
 * Output is a JSON envelope { ok, data, error } on stdout (progress on stderr).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandCenterPlan } from "./command-center-plan";
import {
  createExecBdClient,
  importPlan,
  renderPlanMarkdown,
  topoOrder,
  validatePlan,
} from "./plan-import";

export const IDS_FILE = join(import.meta.dir, "command-center-plan.ids.json");

export function loadKnownIds(path: string = IDS_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function saveKnownIds(
  ids: Record<string, string>,
  path: string = IDS_FILE,
): void {
  const sorted = Object.fromEntries(
    Object.entries(ids).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

function main(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const markdown = argv.includes("--markdown");
  const sync = argv.includes("--sync");
  const errors = validatePlan(commandCenterPlan);
  if (errors.length) {
    console.log(
      JSON.stringify({ ok: false, data: null, error: errors.join("; ") }),
    );
    return 1;
  }
  if (dryRun) {
    const order = topoOrder(commandCenterPlan).map((i) => i.key);
    if (markdown) {
      console.log(renderPlanMarkdown(commandCenterPlan, loadKnownIds()));
      return 0;
    }
    console.log(
      JSON.stringify({
        ok: true,
        data: { order, count: order.length },
        error: null,
      }),
    );
    return 0;
  }
  try {
    const result = importPlan(commandCenterPlan, createExecBdClient(), {
      knownIds: loadKnownIds(),
      sync,
      log: (line) => console.error(line),
    });
    saveKnownIds(result.ids);
    if (markdown) {
      console.log(renderPlanMarkdown(commandCenterPlan, result.ids));
      return 0;
    }
    console.log(JSON.stringify({ ok: true, data: result, error: null }));
    return 0;
  } catch (e: unknown) {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

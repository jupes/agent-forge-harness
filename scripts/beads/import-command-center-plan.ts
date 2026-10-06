/**
 * Import (or re-sync) the Agent Forge Command Center bead graph.
 *
 *   bun run beads:import-command-center-plan            # idempotent import via bd
 *   bun run beads:import-command-center-plan --dry-run  # validate + print order, no bd calls
 *   bun run beads:import-command-center-plan --markdown # print the bead map table for docs
 *
 * Output is a JSON envelope { ok, data, error } on stdout (progress on stderr).
 */
import { commandCenterPlan } from "./command-center-plan";
import {
  createExecBdClient,
  importPlan,
  renderPlanMarkdown,
  topoOrder,
  validatePlan,
} from "./plan-import";

function main(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const markdown = argv.includes("--markdown");
  const errors = validatePlan(commandCenterPlan);
  if (errors.length) {
    console.log(
      JSON.stringify({ ok: false, data: null, error: errors.join("; ") }),
    );
    return 1;
  }
  if (markdown) {
    let ids: Record<string, string> = {};
    if (!dryRun) {
      try {
        ids = importPlan(commandCenterPlan, createExecBdClient()).ids;
      } catch (e: unknown) {
        console.error(
          `bd unavailable, printing keys only: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    console.log(renderPlanMarkdown(commandCenterPlan, ids));
    return 0;
  }
  if (dryRun) {
    const order = topoOrder(commandCenterPlan).map((i) => i.key);
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
    const result = importPlan(commandCenterPlan, createExecBdClient(), (line) =>
      console.error(line),
    );
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

process.exit(main(process.argv.slice(2)));

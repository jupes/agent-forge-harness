#!/usr/bin/env bun
/**
 * filemap-cli.ts — check a file map before a task is created from it, or read
 * the one a task already has.
 *
 *   bun run scripts/scheduler/filemap-cli.ts <description.md>
 *   bun run scripts/scheduler/filemap-cli.ts <plan.md> --plan
 *   bd show <task-id> --json | bun run scripts/scheduler/filemap-cli.ts - --bd-json
 *
 * The first form reads one task description and prints its file map. The
 * second reads a plan document and prints the map of every checkpoint: the
 * parser reads only the first `Files` section of a text, so a plan has to be
 * checked checkpoint by checkpoint. The third reads what `bd show <id> --json`
 * prints and takes the map from the issue's description as it is stored
 * (plain `bd show` renders Markdown and garbles a glob that holds `*`).
 * `-` in place of the file reads standard input.
 *
 * A text given in the wrong form is refused rather than half read: a plan
 * without `--plan`, or that JSON without `--bd-json`.
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when every map parsed, 2 when not.
 */

import { readFileSync } from "fs";
import { parseFileMap, parsePlanFileMaps } from "./filemap";

export interface FileMapCliOutcome {
  code: 0 | 2;
  body: { ok: boolean; data: unknown; error: string | null };
}

const USAGE =
  "usage: bun run scripts/scheduler/filemap-cli.ts <description.md | - > [--plan | --bd-json]";

/** The description of the issue `bd show <id> --json` printed, or null when the text is not that. */
function storedDescription(text: string): string | null {
  const start = text.trimStart()[0];
  if (start !== "[" && start !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const issue: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof issue !== "object" || issue === null) return null;
  const description = (issue as { description?: unknown }).description;
  return typeof description === "string" ? description : null;
}

export function runFileMapCli(
  argv: readonly string[],
  deps: { read: (path: string) => string },
): FileMapCliOutcome {
  const refuse = (error: string, data: unknown = null): FileMapCliOutcome => ({
    code: 2,
    body: { ok: false, data, error },
  });
  const paths = argv.filter((arg) => arg === "-" || !arg.startsWith("--"));
  const flags = argv.filter((arg) => arg !== "-" && arg.startsWith("--"));
  const path = paths[0];
  const asPlan = flags.includes("--plan");
  const asBd = flags.includes("--bd-json");
  if (
    path === undefined ||
    paths.length > 1 ||
    flags.some((flag) => flag !== "--plan" && flag !== "--bd-json") ||
    (asPlan && asBd)
  ) {
    return refuse(USAGE);
  }
  let text: string;
  try {
    text = deps.read(path);
  } catch (error) {
    return refuse(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (asBd) {
    const description = storedDescription(text);
    if (description === null) {
      return refuse(
        "--bd-json expects what `bd show <id> --json` prints: an issue with a description",
      );
    }
    text = description;
  } else if (storedDescription(text) !== null) {
    return refuse(
      "this is `bd show <id> --json` output: add --bd-json to read the map from its description",
    );
  }

  const checkpoints = parsePlanFileMaps(text);
  if (!asPlan) {
    // What Beads holds is one task's description, whatever headings it carries.
    if (!asBd && checkpoints.length > 0) {
      return refuse(
        `this text has ${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}: check a plan with --plan, which reads each one`,
      );
    }
    const map = parseFileMap(text);
    return map.ok
      ? { code: 0, body: { ok: true, data: map, error: null } }
      : refuse(map.error, map);
  }

  if (checkpoints.length === 0) {
    return refuse("the plan has no `Checkpoint` heading");
  }
  const refused = checkpoints.flatMap(({ checkpoint, map }) =>
    map.ok ? [] : [`${checkpoint}: ${map.error}`],
  );
  return refused.length === 0
    ? { code: 0, body: { ok: true, data: { checkpoints }, error: null } }
    : refuse(refused.join("; "), { checkpoints });
}

if (import.meta.main) {
  const outcome = runFileMapCli(process.argv.slice(2), {
    // File descriptor 0 is standard input.
    read: (path) => readFileSync(path === "-" ? 0 : path, "utf8"),
  });
  console.log(JSON.stringify(outcome.body, null, 2));
  process.exit(outcome.code);
}

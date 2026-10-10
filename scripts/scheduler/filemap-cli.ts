#!/usr/bin/env bun
/**
 * filemap-cli.ts — check a file map before a task is created from it.
 *
 *   bun run scripts/scheduler/filemap-cli.ts <description.md>
 *   bun run scripts/scheduler/filemap-cli.ts <plan.md> --plan
 *
 * The first form reads one task description and prints its file map. The
 * second reads a plan document and prints the map of every checkpoint: the
 * parser reads only the first `Files` section of a text, so a plan has to be
 * checked checkpoint by checkpoint. `-` in place of the file reads standard
 * input, for a description that comes from another command.
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
  "usage: bun run scripts/scheduler/filemap-cli.ts <description.md | - > [--plan]";

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
  if (
    path === undefined ||
    paths.length > 1 ||
    flags.some((flag) => flag !== "--plan")
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

  if (!flags.includes("--plan")) {
    const map = parseFileMap(text);
    return map.ok
      ? { code: 0, body: { ok: true, data: map, error: null } }
      : refuse(map.error, map);
  }

  const checkpoints = parsePlanFileMaps(text);
  if (checkpoints.length === 0) {
    return refuse("the plan has no `### Checkpoint` heading");
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

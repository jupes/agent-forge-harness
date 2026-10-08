#!/usr/bin/env bun
/**
 * cli.ts — print the merged smiths/benches config with provenance.
 *
 * CLI:
 *   bun run forge:config show            # smiths, benches, env allowlist + where each came from
 *   bun run forge:config get <key>       # one effective value, e.g. workflow.default_crew
 *   bun run forge:config keys            # every key `show` knows about
 *   bun run forge:config show --json     # { ok, data, error }
 *
 * Exit code 0 when ok, 2 when not.
 */

import { join } from "path";
import { type LoadOptions, loadConfig } from "./load";

export interface CliOutcome {
  code: 0 | 2;
  stdout: string;
  stderr: string;
}

function envelope(ok: boolean, data: unknown, error: string | null): string {
  return JSON.stringify({ ok, data: ok ? data : null, error }, null, 2);
}

export function runConfigCli(argv: string[], options: LoadOptions): CliOutcome {
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = positional[0] ?? "show";

  const done = (data: unknown, text: string): CliOutcome => ({
    code: 0,
    stdout: json ? envelope(true, data, null) : text,
    stderr: "",
  });
  const fail = (message: string): CliOutcome => ({
    code: 2,
    stdout: json ? envelope(false, null, message) : "",
    stderr: json ? "" : message,
  });

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(options);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { config, provenance, files } = loaded;
  const keys = Object.keys(provenance).sort();

  if (command === "keys") return done({ keys }, keys.join("\n"));

  if (command === "get") {
    const key = positional[1];
    if (!key) return fail("usage: forge:config get <key>");
    const entry = provenance[key];
    if (!entry) return fail(`unknown key "${key}" (see: forge:config keys)`);
    return done(
      { key, ...entry },
      `${typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}  (from ${entry.source})`,
    );
  }

  if (command === "show") {
    const lines = Object.entries(provenance)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, entry]) =>
          `${key} = ${JSON.stringify(entry.value)}  (${entry.source})`,
      );
    return done({ config, provenance, files }, lines.join("\n"));
  }

  return fail(`unknown command "${command}" (show | get | keys)`);
}

if (import.meta.main) {
  const harnessRoot = join(import.meta.dir, "..", "..");
  const outcome = runConfigCli(process.argv.slice(2), { harnessRoot });
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.code);
}

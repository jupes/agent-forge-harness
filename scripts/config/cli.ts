#!/usr/bin/env bun
/**
 * cli.ts — print the merged smiths/benches config with provenance.
 *
 * CLI:
 *   bun run forge:config show            # smiths, benches, env allowlist + where each came from
 *   bun run forge:config get <key>       # one effective value, e.g. workflow.default_crew
 *   bun run forge:config keys            # every key `set` writes
 *   bun run forge:config set <key> <value> --user|--workspace
 *                                        # one value into the machine file (config.toml in
 *                                        # AGENT_FORGE_HOME, else ~/.agent-forge) or
 *                                        # <harness>/agent-forge.toml; lists are comma-separated
 *   bun run forge:config show --json     # { ok, data, error }
 *
 * Exit code 0 when ok, 2 when not.
 */

import { join } from "path";
import { isMain } from "../is-main";
import { type LoadOptions, loadConfig, machineConfigFile } from "./load";
import { setConfigValue, settableKeys } from "./write";

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

  // Before the current config is loaded: a file that does not load can be repaired.
  if (command === "set") {
    const [, key, raw] = positional;
    const user = argv.includes("--user");
    const workspace = argv.includes("--workspace");
    if (key === undefined || raw === undefined || positional.length > 3)
      return fail("usage: forge:config set <key> <value> --user|--workspace");
    if (user === workspace)
      return fail(
        `say which file to write: --user (${machineConfigFile(options)}) or --workspace (<harness>/agent-forge.toml)`,
      );
    const outcome = setConfigValue({
      key,
      raw,
      target: user ? "user" : "workspace",
      options,
    });
    if (!outcome.ok) return fail(outcome.error);
    const replaced = outcome.replacedUserPass;
    const notice =
      replaced !== undefined
        ? `execution.env.pass from the user file (${replaced.join(", ")}) no longer applies here: this workspace file replaces it`
        : "";
    return {
      ...done(
        outcome,
        `${key} = ${JSON.stringify(outcome.value)}  (written to ${outcome.file})`,
      ),
      stderr: notice,
    };
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(options);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { config, provenance, files } = loaded;
  const keys = settableKeys(config);

  if (command === "keys") return done({ keys }, keys.join("\n"));

  if (command === "get") {
    const key = positional[1];
    if (!key) return fail("usage: forge:config get <key>");
    // A key of its own: `constructor` is on every object.
    const entry = Object.hasOwn(provenance, key) ? provenance[key] : undefined;
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

  return fail(`unknown command "${command}" (show | get | keys | set)`);
}

if (isMain(import.meta)) {
  const harnessRoot = join(import.meta.dir, "..", "..");
  const outcome = runConfigCli(process.argv.slice(2), { harnessRoot });
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.code);
}

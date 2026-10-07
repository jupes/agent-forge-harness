#!/usr/bin/env bun
/**
 * doctor-cli.ts — which provider CLIs can this machine drive?
 *
 *   bun run forge:doctor          # one line per adapter
 *   bun run forge:doctor --json   # { ok, data: { adapters: [...] }, error }
 *
 * A missing CLI is data, not failure: exit 0 unless the doctor itself breaks.
 */

import { ADAPTERS } from "./registry";
import type { DoctorResult, ExecutorAdapter } from "./types";

export async function runDoctor(
  adapters: Readonly<Record<string, ExecutorAdapter>> = ADAPTERS,
  commands: Record<string, string[]> = {},
): Promise<DoctorResult[]> {
  return Promise.all(
    Object.entries(adapters).map(([provider, adapter]) =>
      adapter.doctor(commands[provider]),
    ),
  );
}

function line(r: DoctorResult): string {
  if (!r.found) return `${r.provider}: not found (${r.reason ?? "no binary"})`;
  return `${r.provider}: ${r.ok ? "ok" : "broken"} ${r.version ?? ""} ${r.path ?? ""}${r.reason ? ` (${r.reason})` : ""}`.trim();
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  try {
    const adapters = await runDoctor();
    if (json) {
      console.log(
        JSON.stringify({ ok: true, data: { adapters }, error: null }, null, 2),
      );
    } else {
      for (const r of adapters) console.log(line(r));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      console.log(JSON.stringify({ ok: false, data: null, error: message }));
    else console.error(message);
    process.exit(2);
  }
}

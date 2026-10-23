import { spawnSync } from "node:child_process";
import type { LedgerEventInput } from "../../types/hearth";
import { bunPath, HEARTH_HOME } from "../e2e/servers";

/** Writes only the browser run's isolated metadata ledger, never a conversation or provider. */
export function seedObservationEvents(events: LedgerEventInput[]): void {
  const result = spawnSync(
    bunPath(),
    [
      "-e",
      `
    import { appendEvent } from "./scripts/ledger/append";
    import { openLedger } from "./scripts/ledger/db";
    let events; try { events = JSON.parse(await Bun.stdin.text()); } catch { throw Error("Invalid observation fixtures"); }
    if (!Array.isArray(events)) throw Error("Expected observation fixtures");
    openLedger().transaction(() => { for (const event of events) { const result = appendEvent(event); if (!result.ok) throw Error(result.error); } })();
  `,
    ],
    {
      env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
      encoding: "utf8",
      input: JSON.stringify(events),
      timeout: 15_000,
    },
  );
  if (result.status !== 0)
    throw Error(`Observation metadata fixture failed: ${result.error?.message ?? result.stderr}`);
}

/**
 * Test fixture: append one event to the ledger named by `AGENT_FORGE_HOME` and
 * report what this connection looks like. Spawned by the multi-process tests.
 */

import { ASYNC_HOOK_APPEND_WAIT_MS, appendEvent } from "../append";
import { openLedger } from "../db";

const result = appendEvent(
  {
    kind: "tool.called",
    workspace: "c:/work/harness",
    sessionId: process.argv[2] ?? "sess-fixture",
    payload: { tool: "Bash", argsHash: "sha256:fixture" },
  },
  // These processes append at once, as concurrent async ledger hooks do.
  { waitMs: ASYNC_HOOK_APPEND_WAIT_MS },
);
const pragma = openLedger().query("PRAGMA synchronous").get();
console.log(JSON.stringify({ result, pragma }));
process.exit(result.ok ? 0 : 1);

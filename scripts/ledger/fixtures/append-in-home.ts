/**
 * Test fixture: append one event, under the session id given second on the
 * command line, to the default ledger, but only when the Agent Forge home this
 * process resolves is the one given first. Started by `home-less-child.ts`,
 * which names the home the isolation guard's re-run gave it. Any other home,
 * such as the one under the account's own home directory, is refused with
 * exit code 3 and nothing is written.
 */

import { resolve } from "path";
import { appendEvent } from "../append";
import { ledgerHome } from "../paths";

const allowed = process.argv[2];
const home = resolve(ledgerHome());
if (allowed === undefined || home !== resolve(allowed)) {
  console.error(
    `refused: this process's Agent Forge home is ${home}, not ${allowed ?? "(none named)"}`,
  );
  process.exit(3);
}

const result = appendEvent({
  kind: "tool.called",
  workspace: "c:/work/harness",
  sessionId: process.argv[3] ?? "home-less-child",
  payload: { tool: "Bash", argsHash: "sha256:fixture" },
});
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

#!/usr/bin/env bun
/** Source CLI wrapper. Runtime consumers import the side-effect-free audit core. */
import { isMain } from "../is-main";
import { runAudit } from "./audit-core";

export type { AuditArgs, AuditOutcome, ParsedArgs } from "./audit-core";
export {
  DEFAULT_LIMIT,
  formatTable,
  parseAuditArgs,
  runAudit,
} from "./audit-core";

if (isMain(import.meta)) {
  const outcome = runAudit(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
  });
  console.log(outcome.stdout);
  if (outcome.stderr !== undefined) console.error(outcome.stderr);
  process.exit(outcome.code);
}

#!/usr/bin/env bun
/**
 * ledger-hook.ts — records a hook event in the ledger.
 *
 * Registered for UserPromptSubmit, PostToolUse and Stop. It decides nothing,
 * prints nothing and always exits 0, so it is registered `async`: the session
 * does not wait for it. The event comes from stdin `hook_event_name`.
 *
 *   UserPromptSubmit -> prompt.submitted { hash, length }
 *   PostToolUse      -> tool.called { tool, argsHash, durationMs? }
 *   Stop             -> no event; refreshes the session's cached model
 *
 * With AGENT_FORGE_HOOK_PROBE=1 it also appends the shape of the call (field
 * and variable names, never a value) to <AGENT_FORGE_HOME>/hook-probe.jsonl.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  type HookDeps,
  handlePrompt,
  handleStop,
  handleToolUse,
  hookDeps,
  probeKeys,
} from "../../scripts/ledger/hook-events";
import { ledgerHome } from "../../scripts/ledger/paths";
import {
  type HookInput,
  isAdapterChild,
  readHookInput,
} from "./utils/hook-input";

const HANDLERS: Readonly<
  Record<string, (input: HookInput, deps: HookDeps) => void>
> = {
  UserPromptSubmit: handlePrompt,
  PostToolUse: handleToolUse,
  Stop: handleStop,
};

function probe(input: HookInput): void {
  const home = ledgerHome(process.env);
  mkdirSync(home, { recursive: true });
  appendFileSync(
    join(home, "hook-probe.jsonl"),
    `${JSON.stringify(probeKeys(input, process.env))}\n`,
  );
}

async function main(): Promise<void> {
  if (isAdapterChild()) return;
  const input = await readHookInput();
  if (input === null) return;
  if (process.env.AGENT_FORGE_HOOK_PROBE === "1") {
    try {
      probe(input);
    } catch {
      // The probe is a diagnostic; it never gets in the way of the event.
    }
  }
  const name = input.hook_event_name;
  const handler = typeof name === "string" ? HANDLERS[name] : undefined;
  if (handler === undefined) return;
  handler(input, hookDeps({ env: process.env, cwd: process.cwd() }));
}

main()
  .catch((error: unknown) => {
    console.error(
      `ledger-hook: ${error instanceof Error ? error.message : String(error)}`,
    );
  })
  .finally(() => process.exit(0));

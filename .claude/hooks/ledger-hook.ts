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
import { closeLedger } from "../../scripts/ledger/db";
import { ledgerHome } from "../../scripts/ledger/paths";
import {
  type HookInput,
  isAdapterChild,
  readHookInput,
  readHookStdin,
} from "./utils/hook-input";

const DIAG = process.env.AGENT_FORGE_HOOK_DIAG === "1";
function diag(line: string): void {
  if (DIAG)
    process.stderr.write(
      `DIAG pid=${process.pid} t=${Math.round(performance.now())} abs=${Date.now() % 100000} ${line}\n`,
    );
}

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
  let input: HookInput | null;
  if (DIAG) {
    const began = performance.now();
    const read = await readHookStdin();
    const detail =
      read.kind === "none"
        ? read.reason
        : read.kind === "malformed"
          ? read.error
          : "ok";
    diag(
      `stdin=${read.kind}:${detail} readMs=${Math.round(performance.now() - began)}`,
    );
    input = read.kind === "payload" ? read.input : null;
  } else {
    input = await readHookInput();
  }
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
  const deps = hookDeps({ env: process.env, cwd: process.cwd() });
  const append = deps.append;
  deps.append = (event) => {
    const began = performance.now();
    const result = append(event);
    diag(
      `append ${event.kind} -> ${JSON.stringify(result)} ms=${Math.round(performance.now() - began)}`,
    );
    return result;
  };
  handler(input, deps);
  diag("handler done");
  const closing = performance.now();
  if (process.env.AGENT_FORGE_DIAG_CLOSE === "explicit") closeLedger();
  diag(`closed closeMs=${Math.round(performance.now() - closing)}`);
}

main()
  .catch((error: unknown) => {
    diag(`threw ${error instanceof Error ? error.stack : String(error)}`);
    console.error(
      `ledger-hook: ${error instanceof Error ? error.message : String(error)}`,
    );
  })
  .finally(() => process.exit(0));

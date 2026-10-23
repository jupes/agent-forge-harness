#!/usr/bin/env bun
/** Source CLI only. Compiled modes import the side-effect-free core directly. */
import { isMain } from "./is-main";
import { runCodexSyncEntry } from "./sync-codex-core";

export {
  type CodexSyncSummary,
  runCodexSyncEntry,
  syncCodex,
} from "./sync-codex-core";

if (isMain(import.meta)) process.exitCode = runCodexSyncEntry();

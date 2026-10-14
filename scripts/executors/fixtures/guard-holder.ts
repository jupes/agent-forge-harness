#!/usr/bin/env bun
/**
 * A stand-in for the tree guard alone: it guards the process tree of a pid it
 * did not start (`guardTree(<pid>)`), prints `guarded` as one line, and then
 * waits to be killed. Since the guarded process is not its child, nothing but
 * the guard can end that tree when this process is killed outright.
 */

import { guardTree } from "../tree-guard";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error("usage: guard-holder.ts <pid>");
  process.exit(2);
}
guardTree(pid);
console.log("guarded");
setInterval(() => undefined, 1000);
await new Promise(() => undefined);

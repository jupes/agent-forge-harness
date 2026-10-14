#!/usr/bin/env bun
/**
 * A stand-in harness process for the supervisor's parent-exit tests. It
 * supervises one fake provider CLI in `hang-tree` mode (it starts a child of
 * its own, then both hang), prints both pids as one JSON line
 * (`{ "pid": <provider>, "childPid": <its child> }`), then reads its stdin to
 * the end and leaves with both still running, the way the text it read says:
 *
 *   exit    `process.exit(0)`
 *   crash   an uncaught error
 *
 * Until its stdin ends, and after any other text, it waits: a test that
 * sends it a signal leaves its stdin open.
 *
 * The provider runs in the OS temp directory with only PATH in its
 * environment.
 */

import { tmpdir } from "os";
import { join } from "path";
import { supervise } from "../supervisor";

let announced = false;
const provider = supervise({
  command: [
    process.execPath,
    join(import.meta.dir, "fake-cli.ts"),
    "--fake-mode",
    "hang-tree",
  ],
  cwd: tmpdir(),
  env: { PATH: process.env.PATH ?? "" },
  onLine: (line) => {
    if (announced) return;
    announced = true;
    const { childPid } = JSON.parse(line) as { childPid: number };
    console.log(JSON.stringify({ pid: provider.pid, childPid }));
  },
});

const how = (await new Response(Bun.stdin.stream()).text()).trim();
if (how === "crash") throw new Error("the stand-in harness crashed (fixture)");
if (how === "exit") process.exit(0);
await new Promise(() => undefined);

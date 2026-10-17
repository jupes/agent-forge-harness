#!/usr/bin/env bun
/**
 * A stand-in harness process for the supervisor's parent-exit tests. It
 * supervises one fake provider CLI in `hang-tree` mode (it starts a child of
 * its own, then both hang), prints both pids as one JSON line
 * (`{ "pid": <provider>, "childPid": <its child> }`), then reads its stdin one
 * line at a time (the text after the last newline counts as a line once stdin
 * ends) and does what each says:
 *
 *   exit      `process.exit(0)`
 *   crash     an uncaught error
 *   SIGINT    `process.emit("SIGINT")`: no signal can be sent to a process on
 *   SIGTERM   Windows without ending it outright, so the signal is emitted
 *   own       register an interrupt owner that answers handled, and print
 *             `{ "handled": "<signal>" }` for each signal it is given
 *   decline   register an interrupt owner that answers not handled
 *   release   release the owner registered last
 *
 * After each of the last five it prints `{ "done": "<line>" }`. Until its
 * stdin ends, and after any other text, it waits: a test that sends it a
 * signal leaves its stdin open.
 *
 * The provider runs in the OS temp directory with only PATH in its
 * environment.
 */

import { tmpdir } from "os";
import { join } from "path";
import { ownInterrupts, supervise } from "../supervisor";

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

let release: (() => void) | null = null;

function act(line: string): void {
  if (line === "crash")
    throw new Error("the stand-in harness crashed (fixture)");
  if (line === "exit") process.exit(0);
  if (line === "SIGINT" || line === "SIGTERM") process.emit(line);
  else if (line === "own")
    release = ownInterrupts((signal) => {
      console.log(JSON.stringify({ handled: signal }));
      return true;
    });
  else if (line === "decline") release = ownInterrupts(() => false);
  else if (line === "release") release?.();
  else return;
  console.log(JSON.stringify({ done: line }));
}

const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let text = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  text += decoder.decode(value, { stream: true });
  let end = text.indexOf("\n");
  while (end !== -1) {
    const line = text.slice(0, end).trim();
    text = text.slice(end + 1);
    act(line);
    end = text.indexOf("\n");
  }
}
act(text.trim());
await new Promise(() => undefined);

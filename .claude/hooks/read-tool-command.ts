#!/usr/bin/env bun
/**
 * read-tool-command.ts — prints `tool_input.command` from the hook payload on
 * stdin, for `block-dangerous-git.sh` on a host where `jq` is not on PATH.
 *
 * Not a hook of its own: the script pipes the payload here and matches what
 * this prints. For a payload that is a JSON object, the output is what
 * `jq -r '.tool_input.command'` prints for it: a string as it is, `null` when
 * there is no command, and any other value as two-space indented JSON.
 *
 * Exits 1, printing nothing on stdout, when the payload cannot be read: stdin
 * held no JSON object (a bare `null` included, for which jq prints `null`), or
 * `tool_input` is there but is not an object (where jq stops with an error).
 * The script blocks the command then.
 */

import { type HookInput, readHookStdin } from "./utils/hook-input";

/** What `jq -r '.tool_input.command'` prints for `input`, or null where jq fails. */
export function toolCommandText(input: HookInput): string | null {
  const toolInput = input.tool_input;
  if (toolInput === undefined || toolInput === null) return "null";
  if (typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const command = (toolInput as Readonly<Record<string, unknown>>).command;
  if (command === undefined || command === null) return "null";
  if (typeof command === "string") return command;
  return JSON.stringify(command, null, 2);
}

async function main(): Promise<number> {
  const read = await readHookStdin();
  if (read.kind !== "payload") {
    const why = read.kind === "malformed" ? read.error : `stdin ${read.reason}`;
    console.error(`read-tool-command: ${why}`);
    return 1;
  }
  const text = toolCommandText(read.input);
  if (text === null) {
    console.error("read-tool-command: tool_input is not an object");
    return 1;
  }
  // Awaited so the text is out before the process.exit below.
  await Bun.write(Bun.stdout, `${text}\n`);
  return 0;
}

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      console.error(
        `read-tool-command: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    })
    .then((code) => process.exit(code));
}

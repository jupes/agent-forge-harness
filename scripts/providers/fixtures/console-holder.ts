/** Holds a native job; the test kills only this process to prove OS cleanup. */
import { launchWindowsConsole } from "../native-console";

const [root, record] = process.argv.slice(2);
if (!root || !record) throw Error("Explicit inert fixture paths required");
const child = launchWindowsConsole({
  command: [process.execPath, `${import.meta.dir}/console-cli.ts`, "hang-tree"],
  cwd: root,
  env: {
    SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
    CONSOLE_FIXTURE_RECORD: record,
  },
  timeoutMs: 15_000,
  visible: false,
});
await child.done;

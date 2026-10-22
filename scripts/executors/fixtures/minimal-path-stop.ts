/** A real supervised provider tree under a parent whose PATH contains no OS utilities. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise } from "../supervisor";

let ready: () => void = () => {};
let childPid: number | undefined;
const announced = new Promise<void>((resolve) => {
  ready = resolve;
});
const provider = supervise({
  command: [
    process.execPath,
    join(import.meta.dir, "fake-cli.ts"),
    "--fake-mode",
    "hang-tree",
  ],
  cwd: tmpdir(),
  env: { PATH: "" },
  timeoutMs: 15_000,
  onLine(line) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "childPid" in value &&
      typeof value.childPid === "number"
    ) {
      childPid = value.childPid;
      ready();
    }
  },
});
await announced;
process.stdout.write(JSON.stringify({ pid: provider.pid, childPid }) + "\n");
await provider.stop("Minimal PATH stop regression");
const exit = await provider.done;
process.stdout.write(
  JSON.stringify({
    ok: exit.stopped,
    data: { exitCode: exit.exitCode },
    error: null,
  }) + "\n",
);

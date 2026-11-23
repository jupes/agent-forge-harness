/** Closed oracle: delay this owner only after the real child reports partial output. */
import { buildChildEnv } from "../env";
import { liveChildCount, supervise } from "../supervisor";

const command = process.argv[2];
if (!command) throw Error("Missing closed fixture command");
const lines: string[] = [];
let held = false;
const handle = supervise({
  command: [command, "deadline-tree"],
  cwd: import.meta.dir,
  env: buildChildEnv(process.env, []),
  stdinMode: "interactive",
  timeoutMs: 800,
  onLine(line) {
    lines.push(line);
    if (line === "partial native text" && !held) {
      held = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    }
  },
});
try {
  const providerPid = await handle.providerPid;
  await handle.end();
  const result = await handle.done;
  console.log(
    JSON.stringify({
      providerPid,
      lines,
      held,
      result,
      live: liveChildCount(),
    }),
  );
} finally {
  await handle.stop("closed oracle cleanup");
}

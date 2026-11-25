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
  windowsHide: true,
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
  if (process.argv[3] === "after-timeout") await handle.done;
  const eof = await handle.end().then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const result = await handle.done;
  // The deadline can close stdin before the fixture asks for EOF. Require
  // the settled owner result before accepting that specific refusal.
  if (
    eof &&
    (!result.timedOut ||
      result.stopped ||
      result.ownedTreeReleased !== true ||
      !(eof.error instanceof Error) ||
      eof.error.message !== "Interactive stdin is closed.")
  )
    throw eof.error;
  console.log(
    JSON.stringify({
      providerPid,
      lines,
      held,
      eofClosed: eof !== null,
      result,
      live: liveChildCount(),
    }),
  );
} finally {
  await handle.stop("closed oracle cleanup");
}

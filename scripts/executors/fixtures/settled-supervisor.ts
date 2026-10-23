/** Actual held child; only this already-exited fixture identity is intercepted. */
import { buildChildEnv } from "../env";
import { supervise } from "../supervisor";
import { guardRequiredTree, guardSuspendedWindowsProcess } from "../tree-guard";

let released = false;
let lateTermination = 0;
const handle = supervise({
  command: [process.execPath, "-e", "process.exit(0)"],
  cwd: import.meta.dir,
  env: buildChildEnv(process.env, []),
  stdinMode: "interactive",
  timeoutMs: 3000,
  onLine() {},
  interactiveGuard(pid) {
    const guard =
      process.platform === "win32"
        ? guardSuspendedWindowsProcess(pid)
        : guardRequiredTree(pid);
    if (!guard) return null;
    return {
      release() {
        released = true;
        guard.release();
      },
      terminate() {
        if (released) lateTermination++;
        guard.terminate?.();
      },
    };
  },
});
await handle.providerPid;
await handle.end().catch(() => undefined);
await handle.done;
let lateSignal = 0;
const realKill = process.kill;
process.kill = (pid, signal) => {
  // No real signal is sent under an identity whose ownership already ended.
  if (pid === handle.pid || pid === -handle.pid) {
    lateSignal++;
    return true;
  }
  return realKill(pid, signal);
};
try {
  await handle.stop("An already settled handle");
} finally {
  process.kill = realKill;
}
console.log(
  JSON.stringify({
    ok: true,
    data: { released, lateTermination, lateSignal },
    error: null,
  }),
);

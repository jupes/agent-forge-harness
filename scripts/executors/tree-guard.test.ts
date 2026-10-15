import { expect, test } from "bun:test";
import { join } from "path";
import { killTree } from "./supervisor";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const HOLDER = join(import.meta.dir, "fixtures", "guard-holder.ts");
const WINDOWS = process.platform === "win32";

/** Whether a process with this pid is running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the process is gone within `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/** The first line a process prints. */
async function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split(/\r?\n/)[0] ?? "";
}

// The process-level tests in `supervisor.test.ts` kill a harness that started
// the provider itself. Here the process that holds the guard did not start the
// tree it guards, so no link from a parent to its children (a parent-death
// signal, a job the runtime keeps for its own children) can be what ends it.
// The provider has started its child before the guard is set up: elsewhere the
// watcher kills the provider's whole process group, child included; on Windows
// a process started before the assignment is outside the job, a limit the
// guard documents, and the child is left running.
test(`a process that holds only the guard of a tree it did not start, killed outright: the provider ends, and its child, started before the guard, ${WINDOWS ? "is left running (outside the job)" : "ends with it (same process group)"}`, async () => {
  const provider = Bun.spawn(
    [process.execPath, FAKE, "--fake-mode", "hang-tree"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true },
  );
  let childPid: number | undefined;
  let holder: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    childPid = (
      JSON.parse(await firstLine(provider.stdout)) as { childPid: number }
    ).childPid;
    holder = Bun.spawn([process.execPath, HOLDER, String(provider.pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await firstLine(holder.stdout)).toBe("guarded");
    expect(running(childPid)).toBe(true);
    holder.kill("SIGKILL");
    await holder.exited;
    const providerEnded = await Promise.race([
      provider.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    expect({
      providerEnded,
      providerChildGone: await goneWithin(childPid, WINDOWS ? 500 : 3000),
    }).toEqual({ providerEnded: true, providerChildGone: !WINDOWS });
  } finally {
    for (const pid of [provider.pid, childPid])
      if (pid !== undefined && running(pid)) killTree(pid);
    if (holder !== undefined && holder.exitCode === null) holder.kill();
  }
});

import {
  INTERACTIVE_BOOTSTRAP_ACK,
  INTERACTIVE_BOOTSTRAP_CONTROL,
  INTERACTIVE_BOOTSTRAP_TERMINAL,
} from "../interactive-bootstrap";

async function terminal(pid: number, timedOut: boolean) {
  const ack = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Missing fixture acknowledgement")),
      1000,
    );
    process.once("message", (message: unknown) => {
      clearTimeout(timer);
      if (
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === INTERACTIVE_BOOTSTRAP_ACK
      )
        resolve();
      else reject(Error("Invalid fixture acknowledgement"));
    });
  });
  process.send?.({
    kind: INTERACTIVE_BOOTSTRAP_TERMINAL,
    version: 1,
    pid,
    timedOut,
  });
  await ack;
}

// Trusted failure fixture. Read the ownership grant before emitting any control frame.
const reader = Bun.stdin.stream().getReader();
let first = "";
for (;;) {
  const next = await reader.read();
  if (next.done) throw Error("Missing fixture grant");
  first += new TextDecoder().decode(next.value);
  if (next.value.includes(10)) break;
}
const mode = process.argv[2];
if (mode?.startsWith("terminal-invalid-")) {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const start = {
    kind: INTERACTIVE_BOOTSTRAP_CONTROL,
    version: 1,
    pid: child.pid,
  };
  const end = {
    kind: INTERACTIVE_BOOTSTRAP_TERMINAL,
    version: 1,
    pid: child.pid,
    timedOut: false,
  };
  if (mode === "terminal-invalid-order") process.send?.(end);
  else {
    process.send?.(start);
    if (mode === "terminal-invalid-missing") process.exit(1);
    if (mode === "terminal-invalid-pid")
      process.send?.({ ...end, pid: child.pid + 1 });
    else if (mode === "terminal-invalid-version")
      process.send?.({ ...end, version: 2 });
    else if (mode === "terminal-invalid-extra")
      process.send?.({ ...end, extra: true });
    else if (mode === "terminal-invalid-value")
      process.send?.({ ...end, timedOut: "true" });
    else if (mode === "terminal-invalid-duplicate") {
      process.send?.(end);
      process.send?.({ ...end, timedOut: true });
    }
  }
  await new Promise(() => setInterval(() => {}, 1000));
}
if (process.argv[2] === "terminal-timeout") {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  process.send?.({
    kind: INTERACTIVE_BOOTSTRAP_CONTROL,
    version: 1,
    pid: child.pid,
  });
  child.kill("SIGKILL");
  await child.exited;
  await terminal(child.pid, true);
  process.exit(1);
}
if (process.argv[2] === "lifetime") {
  let value: unknown;
  try {
    value = JSON.parse(first.split("\n")[0] ?? "");
  } catch {
    throw Error("Invalid fixture grant");
  }
  if (!value || typeof value !== "object" || !("timeoutMs" in value))
    throw Error("Missing fixture lifetime");
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  process.send?.({
    kind: INTERACTIVE_BOOTSTRAP_CONTROL,
    version: 1,
    pid: child.pid,
  });
  console.log(
    JSON.stringify({
      timeoutMs: value.timeoutMs,
      lifetime: "lifetime" in value ? value.lifetime : null,
    }),
  );
  await terminal(child.pid, false);
  process.exit(0);
}
if (process.argv[2] === "malformed")
  process.send?.({ kind: "unknown", pid: process.pid });
else {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    {
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  process.send?.({
    kind: INTERACTIVE_BOOTSTRAP_CONTROL,
    version: 1,
    pid: child.pid,
  });
  process.send?.({
    kind: INTERACTIVE_BOOTSTRAP_CONTROL,
    version: 1,
    pid: child.pid,
  });
}
await new Promise(() => setInterval(() => {}, 1000));

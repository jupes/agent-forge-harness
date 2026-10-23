import { INTERACTIVE_BOOTSTRAP_CONTROL } from "../interactive-bootstrap";

// Trusted failure fixture. Read the ownership grant before emitting any control frame.
const reader = Bun.stdin.stream().getReader();
let first = "";
for (;;) {
  const next = await reader.read();
  if (next.done) throw Error("Missing fixture grant");
  first += new TextDecoder().decode(next.value);
  if (next.value.includes(10)) break;
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
  process.send?.({ kind: INTERACTIVE_BOOTSTRAP_CONTROL, pid: child.pid });
  console.log(
    JSON.stringify({
      timeoutMs: value.timeoutMs,
      lifetime: "lifetime" in value ? value.lifetime : null,
    }),
  );
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
  process.send?.({ kind: INTERACTIVE_BOOTSTRAP_CONTROL, pid: child.pid });
  process.send?.({ kind: INTERACTIVE_BOOTSTRAP_CONTROL, pid: child.pid });
}
await new Promise(() => setInterval(() => {}, 1000));

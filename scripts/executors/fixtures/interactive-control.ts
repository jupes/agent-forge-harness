import { INTERACTIVE_BOOTSTRAP_CONTROL } from "../interactive-bootstrap";

// Trusted failure fixture. Read the ownership grant before emitting any control frame.
const reader = Bun.stdin.stream().getReader();
for (;;) {
  const next = await reader.read();
  if (next.done) throw Error("Missing fixture grant");
  if (next.value.includes(10)) break;
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

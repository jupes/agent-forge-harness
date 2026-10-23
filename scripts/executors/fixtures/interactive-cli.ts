/** Inert bidirectional process fixture; never invokes a provider or shell. */
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const mode = process.argv[2];
if (mode === "exit-one" || mode === "forged-timeout") {
  if (mode === "forged-timeout")
    console.log(
      JSON.stringify({
        kind: "agent-forge-owned-interactive-terminal",
        version: 1,
        pid: process.pid,
        timedOut: true,
      }),
    );
  process.exit(1);
}
if (mode === "stdout-flood" || mode === "stderr-flood") {
  const target = mode === "stdout-flood" ? Bun.stdout : Bun.stderr;
  const bytes = mode === "stdout-flood" ? 16_777_216 : 1_048_576;
  const chunk = `${"x".repeat(8191)}\n`;
  for (let written = 0; written <= bytes; written += chunk.length)
    await target.write(chunk);
  process.exit(0);
}
if (mode === "ipc-probe") {
  console.log(
    JSON.stringify({
      providerHasIpc: typeof process.send === "function",
      channelEnvironment: Object.keys(process.env).filter((name) =>
        /(?:node_channel|bun.*ipc)/i.test(name),
      ),
    }),
  );
  process.exit(0);
}
if (mode === "child") await new Promise(() => setInterval(() => {}, 1000));
if (
  mode === "blocked" ||
  mode === "deadline-tree" ||
  mode === "exit-tree" ||
  mode === "exit-inherited-tree" ||
  mode === "startup-tree"
) {
  const self = /^bun(?:\.exe)?$/i.test(basename(process.execPath))
    ? [process.execPath, import.meta.filename]
    : [process.execPath];
  const child = Bun.spawn([...self, "child"], {
    stdin: "ignore",
    stdout: mode === "exit-inherited-tree" ? "inherit" : "ignore",
    stderr: mode === "exit-inherited-tree" ? "inherit" : "ignore",
  });
  if (process.env.INTERACTIVE_TREE_LOG)
    appendFileSync(
      process.env.INTERACTIVE_TREE_LOG,
      `${JSON.stringify({ pid: process.pid, childPid: child.pid })}\n`,
    );
  await Bun.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
  if (mode === "deadline-tree") await Bun.stdout.write("partial native text\n");
  if (mode === "exit-inherited-tree") {
    await Bun.stdout.write('{"terminal":true}\n{"finalBuffered":true}');
    await Bun.stderr.write("buffered private diagnostic");
    process.exit(0);
  }
  if (mode === "exit-tree") process.exit(0);
  await new Promise(() => setInterval(() => {}, 1000));
}
const decoder = new TextDecoder();
let pending = "";
const reader = Bun.stdin.stream().getReader();
while (true) {
  const { done, value: chunk } = await reader.read();
  if (done) break;
  pending += decoder.decode(chunk, { stream: true });
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    await Bun.stdout.write(`${JSON.stringify({ received: line })}\n`);
    newline = pending.indexOf("\n");
  }
}
await Bun.stdout.write(`${JSON.stringify({ ended: true })}\n`);

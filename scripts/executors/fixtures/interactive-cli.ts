/** Inert bidirectional process fixture; never invokes a provider or shell. */
const mode = process.argv[2];
if (mode === "child") await new Promise(() => setInterval(() => {}, 1000));
if (mode === "blocked" || mode === "exit-tree") {
  const child = Bun.spawn([process.execPath, import.meta.filename, "child"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
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

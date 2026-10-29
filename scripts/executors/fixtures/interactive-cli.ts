/** Inert bidirectional process fixture; never invokes a provider or shell. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename } from "node:path";

const mode = process.argv[2];
const readinessGate = process.env["INTERACTIVE_TREE_READINESS_GATE"];
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
if (mode === "child") {
  if (readinessGate) {
    const release = `${readinessGate}.release`;
    writeFileSync(`${readinessGate}.started`, "started");
    const deadline = Date.now() + 5000;
    while (
      (!existsSync(release) || readFileSync(release, "utf8") !== "child") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    if (!existsSync(release) || readFileSync(release, "utf8") !== "child")
      throw new Error("The bounded child readiness gate was not released.");
    writeFileSync(`${readinessGate}.ack`, "ready");
  }
  await new Promise(() => setInterval(() => {}, 1000));
}
if (
  mode === "blocked" ||
  mode === "deadline-tree" ||
  mode === "exit-tree" ||
  mode === "exit-inherited-tree" ||
  mode === "startup-tree" ||
  mode === "partial-tree"
) {
  const self = /^bun(?:\.exe)?$/i.test(basename(process.execPath))
    ? [process.execPath, import.meta.filename]
    : [process.execPath];
  const child = Bun.spawn([...self, "child"], {
    stdin: "ignore",
    stdout: mode === "exit-inherited-tree" ? "inherit" : "ignore",
    stderr: mode === "exit-inherited-tree" ? "inherit" : "ignore",
    windowsHide: true,
  });
  if (mode === "blocked" && readinessGate) {
    // The test opens the parent publication gate while the helper remains gated.
    const deadline = Date.now() + 5000;
    while (!existsSync(`${readinessGate}.release`) && Date.now() < deadline)
      await Bun.sleep(10);
    if (!existsSync(`${readinessGate}.release`))
      throw new Error("The bounded parent announcement gate was not released.");
  }
  const announcement = `${JSON.stringify({ pid: process.pid, childPid: child.pid })}\n`;
  if (process.env.INTERACTIVE_TREE_LOG) {
    if (mode === "partial-tree") {
      const split = Math.max(1, Math.floor((announcement.length - 1) / 2)),
        ready = process.env.INTERACTIVE_TREE_PUBLICATION_READY,
        release = process.env.INTERACTIVE_TREE_PUBLICATION_RELEASE;
      if (!ready || !release)
        throw Error("The bounded tree publication gate is unavailable.");
      appendFileSync(
        process.env.INTERACTIVE_TREE_LOG,
        announcement.slice(0, split),
      );
      writeFileSync(ready, "ready");
      const deadline = Date.now() + 5000;
      while (!existsSync(release) && Date.now() < deadline) await Bun.sleep(10);
      if (!existsSync(release))
        throw Error("The bounded tree publication gate was not released.");
      appendFileSync(
        process.env.INTERACTIVE_TREE_LOG,
        announcement.slice(split),
      );
    } else appendFileSync(process.env.INTERACTIVE_TREE_LOG, announcement);
  }
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

/** Inert status protocol fixture. Never imports a provider or accesses an account. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isConsoleWindowVisible } from "./console-visibility";

const args = process.argv.slice(2);
const helperDirectory = process.env["READINESS_FIXTURE_HELPER_DIR"];
if (args[0] === "--readiness-helper" && helperDirectory) {
  const key = args[1];
  if (key !== "version" && key !== "status") process.exit(2);
  const ready = join(helperDirectory, `${key}.ready`);
  const release = join(helperDirectory, `${key}.release`);
  const exited = join(helperDirectory, `${key}.exited`);
  writeFileSync(ready, String(process.pid));
  const deadline = Date.now() + 15_000;
  while (!existsSync(release) && Date.now() < deadline) await Bun.sleep(10);
  writeFileSync(exited, "exited");
  process.exit(0);
}
if (process.env["READINESS_FIXTURE_REQUIRE_EOF"] === "1") {
  const reader = Bun.stdin.stream().getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > 0)
        throw Error("Readiness probes must receive empty stdin.");
    }
  } finally {
    reader.releaseLock();
  }
}
const record = process.env["READINESS_FIXTURE_RECORD"];
const helperKey = process.argv.slice(-2).join(" ") === "auth status"
  ? "status"
  : null;
if (
  helperDirectory &&
  process.env["READINESS_FIXTURE"] === "owned-helper" &&
  helperKey
) {
  const child = Bun.spawn(
    [process.execPath, import.meta.filename, "--readiness-helper", helperKey],
    {
      env: { READINESS_FIXTURE_HELPER_DIR: helperDirectory },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform === "win32",
      windowsHide: true,
    },
  );
  const ready = join(helperDirectory, `${helperKey}.ready`);
  const deadline = Date.now() + 2000;
  while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(ready)) throw Error("Readiness helper did not become ready.");
  if (Number(readFileSync(ready, "utf8")) !== child.pid)
    throw Error("Readiness helper identity did not match its parent.");
}
if (record)
  appendFileSync(
    record,
    `${JSON.stringify({
      pid: process.pid,
      args,
      consoleWindowVisible: isConsoleWindowVisible(),
    })}\n`,
  );

if (process.argv.includes("--version"))
  console.log("Claude Code fixture 2.1.293");
else if (process.argv.slice(-2).join(" ") !== "auth status") process.exit(2);
else if (process.env["READINESS_FIXTURE"] === "hang")
  await new Promise(() => {});
else if (process.env["READINESS_FIXTURE"] === "overflow")
  console.log("x".repeat(100000));
else if (
  process.env["READINESS_FIXTURE"] === "signed-out" ||
  process.env["READINESS_FIXTURE"] === "visibility"
) {
  console.log('{"authMethod":"none","loggedIn":false}');
  process.exitCode = 1;
} else {
  const report = JSON.stringify({
      authMethod: "api_key",
      loggedIn: true,
      apiKey: "fixture-secret-never-forward",
      email: "private@example.test",
  });
  if (
    process.env["READINESS_FIXTURE"] === "owned-helper" &&
    helperKey === "status"
  ) {
    await Bun.stdout.write(`${report}\n`);
    process.exit(0);
  }
  console.log(report);
}

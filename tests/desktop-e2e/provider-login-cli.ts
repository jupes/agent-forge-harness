/** Compiled inert vendor-console stand-in. Never reads credentials or contacts a provider. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env["PROVIDER_LOGIN_FIXTURE_HOME"];
if (!home)
  throw Error("An explicit isolated provider login fixture home is required");
if (process.argv[2] === "--child") await new Promise(() => {});
else {
  const provider = process.argv[2];
  if (provider !== "claude" && provider !== "codex")
    throw Error("Fixed fixture provider required");
  const child = Bun.spawn([process.execPath, "--child"], {
    env: { PROVIDER_LOGIN_FIXTURE_HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  appendFileSync(
    join(home, "provider-login-starts.jsonl"),
    `${JSON.stringify({ provider, pid: process.pid, childPid: child.pid })}\n`,
  );
  await new Promise(() => {});
}

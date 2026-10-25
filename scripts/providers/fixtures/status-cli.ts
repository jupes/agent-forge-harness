/** Inert status protocol fixture. Never imports a provider or accesses an account. */
import { appendFileSync } from "node:fs";
import { isConsoleWindowVisible } from "./console-visibility";

const args = process.argv.slice(2);
const record = process.env["READINESS_FIXTURE_RECORD"];
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
} else
  console.log(
    JSON.stringify({
      authMethod: "api_key",
      loggedIn: true,
      apiKey: "fixture-secret-never-forward",
      email: "private@example.test",
    }),
  );

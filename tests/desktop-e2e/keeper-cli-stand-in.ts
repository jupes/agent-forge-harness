/** Compiled as `claude` only inside the desktop suite's isolated CLI directory. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codingFlags, runCodingFixture } from "./session-cli-stand-in";

const home = process.env["AGENT_FORGE_HOME"];
if (!home)
  throw new Error(
    "The Keeper browser stand-in requires an explicit test home.",
  );
let mode: unknown = "normal";
try {
  mode = JSON.parse(
    readFileSync(join(home, "keeper-fixture-mode.json"), "utf8"),
  );
} catch {
  mode = "normal";
}
if (
  typeof mode !== "string" ||
  ![
    "normal",
    "hang",
    "missing-terminal",
    "bad-tool",
    "bad-identity",
    "overflow",
    "legacy",
    "brief",
    "brief-failed",
    "brief-malformed",
    "proposals",
  ].includes(mode)
)
  throw new Error("Unknown Keeper browser fixture mode.");
process.env["KEEPER_FIXTURE_MODE"] = mode;
process.env["KEEPER_FIXTURE_RECORD"] = join(home, "keeper-fixture-record.json");
if (process.argv.slice(-2).join(" ") === "auth status") {
  process.stdout.write(
    JSON.stringify({
      authMethod: "api_key",
      loggedIn: true,
      apiKey: "inert-browser-fixture-not-a-key",
    }),
  );
} else if (process.argv.includes("--help") && mode !== "legacy") {
  process.stdout.write(
    `${codingFlags} --tools --restricted --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --append-system-prompt\n`,
  );
} else if (
  !process.argv.includes("--version") &&
  !process.argv.includes("--help") &&
  !process.argv.includes("--restricted")
) {
  await runCodingFixture(home);
} else {
  if (!process.argv.includes("--version") && !process.argv.includes("--help"))
    appendFileSync(
      join(home, "keeper-fixture-starts.jsonl"),
      JSON.stringify({ started: true }) + "\n",
    );
  await import("../../scripts/keeper/fixtures/claude-conversation");
}

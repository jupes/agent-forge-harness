/** This compiled fake never reaches a provider or another directory. */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const home = process.env["AGENT_FORGE_HOME"];
if (!home) throw new Error("Explicit restart fixture home required.");
if (process.env["DESKTOP_RESTART_KEEPER_PROJECT_ID"] !== undefined)
  throw new Error("Keeper fixture identity must come from private metadata.");
if (
  Object.keys(process.env).some((name) =>
    /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|XAI_API_KEY|OPENROUTER_API_KEY|CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(
      name,
    ),
  )
)
  throw new Error(
    "Ambient provider credentials or config reached the isolated fake CLI.",
  );
let recordedIntent = false;
let restartFixture: unknown;
try {
  restartFixture = JSON.parse(
    readFileSync(join(home, "restart-fixture.json"), "utf8"),
  );
} catch {
  throw new Error("The dedicated Keeper fixture metadata was unavailable.");
}
const fixtureRecord =
  typeof restartFixture === "object" &&
  restartFixture !== null &&
  !Array.isArray(restartFixture)
    ? (restartFixture as Record<string, unknown>)
    : null;
const keeperProjectId = fixtureRecord?.["keeperProjectId"];
const fixtureRoot = fixtureRecord?.["root"];
if (
  typeof keeperProjectId !== "string" ||
  !/^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    keeperProjectId,
  )
)
  throw new Error("The dedicated Keeper fixture project was unavailable.");
try {
  if (
    typeof fixtureRoot !== "string" ||
    realpathSync.native(resolve(fixtureRoot)) !==
    realpathSync.native(resolve(home, "repository"))
  )
    throw new Error("Foreign restart fixture.");
  const mode = JSON.parse(
    readFileSync(join(home, "restart-capability-mode.json"), "utf8"),
  );
  const journal = JSON.parse(
    readFileSync(
      join(home, "conversations", `keeper-${keeperProjectId}-proposals.json`),
      "utf8",
    ),
  );
  recordedIntent =
    mode === "refuse-recorded-intent" &&
    Array.isArray(journal.sessionStarts) &&
    journal.sessionStarts.length > 0;
} catch {
  recordedIntent = false;
}
if (
  recordedIntent &&
  process.argv.some((arg) => arg === "--version" || arg === "--help")
) {
  appendFileSync(
    join(home, "restart-capability-refusals.jsonl"),
    JSON.stringify({ refused: true }) + "\n",
  );
  process.stderr.write(
    "Recorded fixture: read-only capability probe unavailable.\n",
  );
  process.exit(1);
}
await import("../desktop-e2e/keeper-cli-stand-in");

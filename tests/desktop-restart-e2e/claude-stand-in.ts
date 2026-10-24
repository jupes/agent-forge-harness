/** This compiled fake never reaches a provider or another directory. */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const home = process.env["AGENT_FORGE_HOME"];
if (!home) throw new Error("Explicit restart fixture home required.");
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
try {
  const marker = JSON.parse(
    readFileSync(join(home, "restart-fixture.json"), "utf8"),
  );
  if (
    realpathSync.native(resolve(marker.root)) !==
    realpathSync.native(resolve(home, "repository"))
  )
    throw new Error("Foreign restart fixture.");
  const mode = JSON.parse(
    readFileSync(join(home, "restart-capability-mode.json"), "utf8"),
  );
  const journal = JSON.parse(
    readFileSync(
      join(
        home,
        "conversations",
        "keeper-project-a5832fa0-7a21-403b-8184-44892f0d8d86-proposals.json",
      ),
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

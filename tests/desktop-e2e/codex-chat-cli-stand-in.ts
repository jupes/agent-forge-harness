/** Dedicated inert app-server executable. Derives only this suite's planted fixture directory. */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const bin = dirname(process.execPath),
  parent = dirname(bin);
if (basename(bin) !== "bin" || basename(parent) !== "bd-stand-in")
  throw Error("The native Chat fixture requires its isolated bin directory.");
const home = resolve(parent, "..");
let mode: unknown = "normal";
try {
  mode = JSON.parse(
    readFileSync(join(home, "codex-chat-fixture-mode.json"), "utf8"),
  );
} catch {
  /* Explicit modes are optional. */
}
if (
  ![
    "normal",
    "scoped-usage",
    "approval-command",
    "approval-file",
    "approval-resolved",
    "approval-timeout",
    "outcome-held",
    "hang-text",
    "provider-error",
  ].includes(String(mode))
)
  throw Error("Unknown isolated Chat fixture mode.");
process.env.CODEX_CHAT_MODE =
  mode === "approval-timeout" || mode === "outcome-held"
    ? "approval-command"
    : String(mode);
process.env.CODEX_CHAT_LOG = join(home, "codex-chat-fixture-calls.jsonl");
await import("../../scripts/sessions/fixtures/codex-app-server-cli");

/** Compiled only in the disposable browser suite: no forwarding, network or account access. */
import { basename, dirname, join, resolve } from "node:path";
import { runGeminiTaskRuntimeFixture } from "../../scripts/sessions/fixtures/gemini-task-runtime-fixture";

const bin = dirname(process.execPath),
  parent = dirname(bin);
if (basename(bin) !== "bin" || basename(parent) !== "bd-stand-in")
  throw Error(
    "The inert Gemini fixture requires its isolated compiled bin directory.",
  );
process.env["GEMINI_RUNTIME_LOG"] = join(
  resolve(parent, ".."),
  "gemini-fixture-calls.jsonl",
);
await runGeminiTaskRuntimeFixture();

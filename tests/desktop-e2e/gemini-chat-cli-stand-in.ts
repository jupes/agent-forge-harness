/** Closed compiled browser fixture. It cannot forward a native command or reach an account. */
import { basename, dirname, join, resolve } from "node:path";
import { runGeminiChatFixture } from "../../scripts/sessions/fixtures/gemini-chat-runtime-fixture";

const bin = dirname(process.execPath),
  parent = dirname(bin);
if (basename(bin) !== "bin" || basename(parent) !== "bd-stand-in")
  throw Error(
    "The inert Gemini ACP fixture requires its isolated compiled bin directory.",
  );
process.env.GEMINI_CHAT_LOG = join(
  resolve(parent, ".."),
  "gemini-chat-fixture-calls.json",
);
await runGeminiChatFixture();

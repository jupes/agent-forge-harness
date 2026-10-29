/** Inert compiled Claude-resume process for the managed terminal acceptance case. */
import { dlopen, FFIType } from "bun:ffi";
import { writeFileSync } from "node:fs";

const record = process.env["CLAUDE_TERMINAL_FIXTURE_RECORD"];
if (!record) throw Error("An explicit terminal fixture record is required.");
const resume = process.argv.indexOf("--resume");
if (resume < 0) throw Error("The exact native resume UUID was not passed.");
const consoleApi =
  process.platform === "win32"
    ? dlopen("kernel32.dll", {
        GetConsoleWindow: { args: [], returns: FFIType.ptr },
      })
    : null;
writeFileSync(
  record,
  JSON.stringify({
    args: process.argv.slice(resume),
    cwd: process.cwd(),
    hasConsole: consoleApi
      ? consoleApi.symbols.GetConsoleWindow() !== null
      : false,
  }),
);
console.log("Inert Claude terminal acceptance fixture.");
if (process.env["CLAUDE_TERMINAL_FIXTURE_HOLD"] === "1")
  await new Promise(() => {});

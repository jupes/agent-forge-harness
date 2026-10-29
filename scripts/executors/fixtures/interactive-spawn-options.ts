import { writeSync } from "node:fs";

const observer = (_command: string[], options: { windowsHide?: boolean }) => {
  const hasOwn = Object.hasOwn(options, "windowsHide"),
    value =
      typeof options.windowsHide === "boolean" ? options.windowsHide : null;
  writeSync(1, `${JSON.stringify({ hasOwn, value })}\n`);
  throw new Error("Target launch observed without starting it.");
};
if (
  !Reflect.set(Bun, "spawn", observer) ||
  Reflect.get(Bun, "spawn") !== observer
)
  throw new Error("The spawn observer could not be installed.");

const { runInteractiveBootstrap } = await import("../interactive-bootstrap");
await runInteractiveBootstrap();

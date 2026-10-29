import { writeSync } from "node:fs";

Object.defineProperty(Bun, "spawn", {
  configurable: true,
  value: (_command: string[], options: { windowsHide?: boolean }) => {
    const hasOwn = Object.prototype.hasOwnProperty.call(options, "windowsHide"),
      value =
        typeof options.windowsHide === "boolean"
          ? options.windowsHide
          : null;
    writeSync(1, `${JSON.stringify({ hasOwn, value })}\n`);
    throw new Error("Target launch observed without starting it.");
  },
});

const { runInteractiveBootstrap } = await import("../interactive-bootstrap");
await runInteractiveBootstrap();

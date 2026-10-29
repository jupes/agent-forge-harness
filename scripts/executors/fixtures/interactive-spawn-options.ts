import { runInteractiveBootstrap } from "../interactive-bootstrap";

Object.defineProperty(process, "send", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(Bun, "spawn", {
  configurable: true,
  value: (_command: string[], options: { windowsHide?: boolean }) => {
    const hasOwn = Object.prototype.hasOwnProperty.call(
        options,
        "windowsHide",
      ),
      value = typeof options.windowsHide === "boolean"
        ? options.windowsHide
        : null;
    process.stdout.write(`${JSON.stringify({ hasOwn, value })}\n`);
    throw new Error("Target launch observed without starting it.");
  },
});

await runInteractiveBootstrap();

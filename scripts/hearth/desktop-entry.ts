import { resolve } from "node:path";
import { startDesktopHost } from "./desktop-host";

export function parseDesktopArguments(args: readonly string[]): {
  root: string;
  assetsRoot: string;
  hearthCommand: string[];
} {
  if (
    args.length !== 6 ||
    args[0] !== "--root" ||
    args[2] !== "--assets" ||
    args[4] !== "--hearth"
  )
    throw new Error(
      "Expected --root <checkout> --assets <built assets dir> --hearth <executable>",
    );
  const [root, assetsRoot, hearth] = [args[1], args[3], args[5]];
  if (!root || !assetsRoot || !hearth)
    throw new Error("Desktop host arguments must not be empty");
  return {
    root: resolve(root),
    assetsRoot: resolve(assetsRoot),
    hearthCommand: [resolve(hearth)],
  };
}

export async function runDesktopEntry(args: readonly string[]): Promise<void> {
  let host: Awaited<ReturnType<typeof startDesktopHost>> | null = null;
  let closeRequested = false;
  let closing: Promise<void> | null = null;
  const close = () => {
    closeRequested = true;
    if (host) closing ??= host.close();
    return closing ?? Promise.resolve();
  };
  process.stdin.once("end", () => {
    void close();
  });
  process.stdin.resume();
  process.once("SIGTERM", () => {
    void close().finally(() => {
      process.exitCode = 0;
    });
  });
  process.once("SIGINT", () => {
    void close().finally(() => {
      process.exitCode = 0;
    });
  });
  try {
    const options = parseDesktopArguments(args);
    host = await startDesktopHost(options);
    if (closeRequested) {
      await close();
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { url: host.url }, error: null })}\n`,
    );
  } catch {
    if (host) await host.close().catch(() => {});
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: "Desktop host startup failed" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await runDesktopEntry(Bun.argv.slice(2));

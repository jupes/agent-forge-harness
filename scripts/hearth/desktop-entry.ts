import { resolve } from "node:path";
import { isMain } from "../is-main";
import { startDesktopHost } from "./desktop-host";
import { hearthHome } from "./home";
import { createSupervisor } from "./supervisor";

/** Cleanup cannot attach, start, or claim a hearth: only stop its exact owner. */
export async function runDesktopCleanup(
  args: readonly string[],
  home = hearthHome(),
): Promise<void> {
  if (
    args.length !== 5 ||
    args[0] !== "--cleanup" ||
    args[1] !== "--root" ||
    !args[2] ||
    args[3] !== "--owner" ||
    !args[4] ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      args[4],
    )
  )
    throw new Error("Invalid desktop cleanup arguments");
  await createSupervisor({
    root: resolve(args[2]),
    home,
    id: args[4],
  }).stopIfOwner();
}

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
  if (args[0] === "--cleanup") {
    try {
      await runDesktopCleanup(args);
    } catch {
      process.exitCode = 1;
    }
    return;
  }
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
      `${JSON.stringify({ ok: true, data: { url: host.url, owner: host.owner }, error: null })}\n`,
    );
  } catch {
    if (host) await host.close().catch(() => {});
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: "Desktop host startup failed" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta)) await runDesktopEntry(process.argv.slice(2));

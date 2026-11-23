/**
 * `bun run dashboard:open`: print a fresh launch link for this root's running
 * dashboard, to open it in another browser or window (`x1gs.3.31`).
 *
 * The page gets the operator token only with a session from a launch link
 * (`launch.ts`), and a launch link is good for five minutes and one use, so
 * the one `bun run dashboard` printed at start does not open a new window an
 * hour later. This command mints another the way the dashboard does: it reads
 * the hearth's token file, which only the user who started the hearth can
 * read, and asks the hearth over its own loopback socket.
 *
 * Where the dashboard listens comes from the record the running dashboard
 * wrote (`dashboardRecordPath`): the address it bound, which the link names
 * and the session cookie is then set for. `--url` names another base, which
 * must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`, never a name
 * that resolves (`launchBase` says why). `--root` is the checkout (the working
 * directory by default). The link is printed on stdout and nothing else is;
 * why there is none goes to stderr, with exit code 1.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMain } from "../is-main";
import { hearthHome, lockPath, rootKey, tokenPath } from "./home";
import { readHomeFile, readHomeLock } from "./home-guard";
import {
  launchBase,
  launchUrl,
  parseDashboardRecord,
  requestLaunch,
} from "./launch";
import { isPidAlive } from "./lock";
import { type Exchange, healthProblem, loopbackExchange } from "./loopback";
import { readToken } from "./token";

export interface OpenOptions {
  root: string;
  home: string;
  /** The dashboard's base URL; the running dashboard's record when not given. */
  url?: string;
  exchange?: Exchange;
  /** Whether a process is alive; `isPidAlive` by default. */
  isAlive?: (pid: number) => boolean;
}

/** Why no link can be printed, in words for the operator. */
export class NoLaunchLink extends Error {}

/** The base a link is built on (`launchBase`), or why not, for the operator. */
function checkedBase(url: string, from: string): string {
  try {
    return launchBase(url);
  } catch (error) {
    throw new NoLaunchLink(
      `${from}: ${error instanceof Error ? error.message : String(error)}. A launch link carries a secret.`,
    );
  }
}

/** Enumerate names only; every candidate's contents still require a checked read. */
function dashboardBases(
  home: string,
  root: string,
  alive: (pid: number) => boolean,
): string[] {
  const check = readHomeFile(home);
  if (check.problem !== null) throw new NoLaunchLink(check.problem);
  const folder = join(home, "dashboards");
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const key = rootKey(root);
  const matching = new RegExp(
    `^${key}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\\.json$`,
  );
  const bases = new Set<string>();
  for (const name of names.sort()) {
    if (!matching.test(name)) continue;
    const read = readHomeFile(home, join(folder, name));
    if (read.problem !== null) throw new NoLaunchLink(read.problem);
    const record = read.text === null ? null : parseDashboardRecord(read.text);
    const sameRoot =
      record !== null &&
      (process.platform === "win32"
        ? resolve(record.root).toLowerCase() === root.toLowerCase()
        : resolve(record.root) === root);
    if (!sameRoot || record === null || !alive(record.pid)) continue;
    // Dead registrations are ignored, never unlinked by a path after a checked read.
    bases.add(
      checkedBase(
        record.url,
        "The running dashboard is not bound to a loopback address (restart it with bun run dashboard)",
      ),
    );
  }
  return [...bases].sort();
}

/** A fresh launch link for the dashboard of `options.root`. */
export async function freshLaunchLink(options: OpenOptions): Promise<string> {
  const root = resolve(options.root);
  const alive = options.isAlive ?? isPidAlive;
  let base: string;
  if (options.url !== undefined) base = checkedBase(options.url, "--url");
  else {
    const bases = dashboardBases(options.home, root, alive);
    if (bases.length > 1)
      throw new NoLaunchLink(
        `Multiple dashboards are running for ${root}:\n${bases.join("\n")}\nSelect one with --url <address>.`,
      );
    const found = bases[0];
    if (found === undefined)
      throw new NoLaunchLink(
        `No dashboard is running for ${root}. Start one with: bun run dashboard (it prints a launch link), or pass --url http://127.0.0.1:<its port>.`,
      );
    base = found;
  }
  // Read as it is checked, before its port is asked anything (`x1gs.3.38`);
  // `requestLaunch` reads it so again, and sends nothing unless it still names that port.
  const read = readHomeLock(options.home, lockPath(options.home, root));
  if (read.problem !== null) throw new NoLaunchLink(read.problem);
  const lock = read.lock;
  const exchange = options.exchange ?? loopbackExchange;
  const problem =
    lock === null || resolve(lock.root) !== root
      ? "it has no lock"
      : await healthProblem(lock, { exchange });
  if (lock === null || problem !== null)
    throw new NoLaunchLink(
      `No control plane answers for ${root} (${problem}). The dashboard starts it again on its next request: reload the dashboard's page, or start it with bun run dashboard, then run this again.`,
    );
  const token = readToken(tokenPath(options.home, root));
  if (token === null)
    throw new NoLaunchLink(
      `The control plane's token file for ${root} could not be read.`,
    );
  try {
    const minted = await requestLaunch({
      home: options.home,
      root,
      port: lock.port,
      token,
      surface: "cli",
      exchange,
    });
    return launchUrl(base, minted.secret);
  } catch (error) {
    throw new NoLaunchLink(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(
  argv: readonly string[],
  io: {
    out: (text: string) => void;
    err: (text: string) => void;
    env?: Record<string, string | undefined>;
  },
): Promise<number> {
  try {
    const url = argValue(argv, "--url");
    const link = await freshLaunchLink({
      root: argValue(argv, "--root") ?? process.cwd(),
      home: hearthHome(io.env ?? process.env),
      ...(url !== undefined ? { url } : {}),
    });
    io.out(`${link}\n`);
    return 0;
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isMain(import.meta)) {
  main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then((code) => process.exit(code));
}

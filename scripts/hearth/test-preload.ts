/**
 * Preloaded by `bun test` (see `bunfig.toml`).
 *
 * The hearth's tests talk to a hearth on `127.0.0.1` with `fetch`. Under Bun,
 * a process started with `HTTP_PROXY` set and no `NO_PROXY` entry of
 * `127.0.0.1` or `*` sends those requests, operator tokens included, to that
 * proxy, and nothing this process does after it has started changes that
 * (`loopbackProxyVariable` in `loopback.ts`). So such a run is refused here,
 * before any test runs, with what to set instead. The proxy's value is not
 * printed: it can carry a password.
 */

import { loopbackProxyVariable } from "./loopback";

const variable = loopbackProxyVariable(process.env, "bun");
if (variable !== null) {
  process.stderr.write(
    `bun test was started with ${variable} set and no NO_PROXY entry of 127.0.0.1 or *. ` +
      "Under Bun, fetch then sends the hearth tests' requests for 127.0.0.1, operator tokens included, to that proxy, " +
      "and nothing done after start-up changes it. " +
      `Start the run with NO_PROXY=127.0.0.1 (added to any entries it already has), or without ${variable}.\n`,
  );
  process.exit(1);
}

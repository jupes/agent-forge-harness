/**
 * One line that says where the dashboard is, once the dev server listens.
 *
 * Vite's own banner names the address it bound (127.0.0.1 by default, which
 * some terminals do not make a link of), and with `strictPort: false` the
 * port is not always the one asked for: Vite takes the next free one. The
 * line is written from the address the server actually bound, after it
 * bound it.
 *
 * With the hearth plugin in the server (`hearthPlugin`), the line is a launch
 * link: the URL with a one-time secret in its fragment, which the page
 * exchanges for its dashboard session (`scripts/hearth/launch.ts`). Without a
 * session the page reads but gets no operator token. The link uses the very
 * host this line always printed, `localhost` for this machine, because a
 * browser keeps the session cookie for the host it opened: a page opened at
 * `127.0.0.1` holds no cookie set at `localhost`.
 */

import type { AddressInfo } from "node:net";
import type { Logger, Plugin } from "vite";
import { LAUNCH_TTL_MS } from "../hearth/launch";
import { OPEN_COMMAND } from "../hearth/paths";
import type { HearthPluginApi } from "../hearth/vite-plugin";

/** Addresses that mean "this machine": written as localhost, which every terminal makes a link of. */
const THIS_MACHINE = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

/**
 * The hearth plugin's name. Must be `HEARTH_PLUGIN_NAME` of
 * `scripts/hearth/vite-plugin.ts` (a test compares them), which imports this
 * module and so is not imported back for a value.
 */
export const HEARTH_PLUGIN = "agent-forge-hearth";

/** What is printed under the link: how long it is good for, and how to get another. */
export const LAUNCH_NOTE = `  (a one-time link, good for ${LAUNCH_TTL_MS / 60_000} minutes; for a new one: ${OPEN_COMMAND})`;

/**
 * The dashboard's URL for the address a server is listening on, or null for
 * one that is not listening on a port (a pipe, or not listening at all).
 */
export function dashboardUrl(
  address: AddressInfo | string | null,
): string | null {
  if (address === null || typeof address === "string") return null;
  const host = THIS_MACHINE.has(address.address)
    ? "localhost"
    : address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
  return `http://${host}:${address.port}/`;
}

/** The hearth plugin's `api` among a server's plugins, when it is there. */
function hearthApi(
  plugins: readonly Plugin[] | undefined,
): HearthPluginApi | null {
  const found = plugins?.find((plugin) => plugin.name === HEARTH_PLUGIN);
  const api: unknown = found?.api;
  return typeof api === "object" &&
    api !== null &&
    typeof (api as Partial<HearthPluginApi>).launchLink === "function"
    ? (api as HearthPluginApi)
    : null;
}

/**
 * Say where the dashboard is: a launch link when `hearth` mints one, else the
 * bare URL and why there is no link.
 */
export async function announceDashboard(
  url: string,
  hearth: HearthPluginApi | null,
  logger: Pick<Logger, "info" | "warn">,
): Promise<void> {
  if (hearth === null) {
    logger.info(`  Dashboard ready: ${url}`);
    return;
  }
  try {
    logger.info(`  Dashboard ready: ${await hearth.launchLink(url)}`);
    logger.info(LAUNCH_NOTE);
  } catch (error) {
    logger.info(`  Dashboard ready: ${url}`);
    logger.warn(
      `  No launch link (${error instanceof Error ? error.message : String(error)}): the page reads, but sends no operator action until it is opened from one. For one: ${OPEN_COMMAND}`,
    );
  }
}

/** Writes `Dashboard ready: <launch link>` once the dev server is listening. */
export function printDashboardUrlPlugin(): Plugin {
  return {
    name: "agent-forge-print-dashboard-url",
    configureServer(server) {
      const http = server.httpServer;
      if (!http) return;
      http.once("listening", () => {
        const url = dashboardUrl(http.address());
        if (url)
          void announceDashboard(
            url,
            hearthApi(server.config.plugins),
            server.config.logger,
          );
      });
    },
  };
}

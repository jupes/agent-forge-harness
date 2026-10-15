/**
 * One line that says where the dashboard is, once the dev server listens.
 *
 * Vite's own banner names the address it bound (127.0.0.1 by default, which
 * some terminals do not make a link of), and with `strictPort: false` the
 * port is not always the one asked for: Vite takes the next free one. The
 * line is written from the address the server actually bound, after it
 * bound it.
 */

import type { AddressInfo } from "node:net";
import type { Plugin } from "vite";

/** Addresses that mean "this machine": written as localhost, which every terminal makes a link of. */
const THIS_MACHINE = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

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

/** Writes `Dashboard ready: <url>` once the dev server is listening. */
export function printDashboardUrlPlugin(): Plugin {
  return {
    name: "agent-forge-print-dashboard-url",
    configureServer(server) {
      const http = server.httpServer;
      if (!http) return;
      http.once("listening", () => {
        const url = dashboardUrl(http.address());
        if (url) server.config.logger.info(`  Dashboard ready: ${url}`);
      });
    },
  };
}

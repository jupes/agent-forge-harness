import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";
import {
  announceDashboard,
  dashboardUrl,
  HEARTH_PLUGIN,
  LAUNCH_NOTE,
  printDashboardUrlPlugin,
} from "./dashboard-url";

const at = (address: string, port: number, family = "IPv4"): AddressInfo => ({
  address,
  port,
  family,
});

describe("the dashboard's URL, from the address the dev server bound", () => {
  test("a loopback or wildcard address is printed as localhost, with the bound port", () => {
    expect(dashboardUrl(at("127.0.0.1", 8787))).toBe("http://localhost:8787/");
    expect(dashboardUrl(at("0.0.0.0", 8788))).toBe("http://localhost:8788/");
    expect(dashboardUrl(at("::1", 8789, "IPv6"))).toBe(
      "http://localhost:8789/",
    );
    expect(dashboardUrl(at("::", 8790, "IPv6"))).toBe("http://localhost:8790/");
  });

  test("any other address is printed as it is, an IPv6 one in brackets so it stays a URL", () => {
    expect(dashboardUrl(at("192.168.1.20", 8787))).toBe(
      "http://192.168.1.20:8787/",
    );
    expect(dashboardUrl(at("fe80::1", 8787, "IPv6"))).toBe(
      "http://[fe80::1]:8787/",
    );
  });

  test("a server listening on a pipe, or not listening, has no URL", () => {
    expect(dashboardUrl("\\\\.\\pipe\\dashboard")).toBeNull();
    expect(dashboardUrl(null)).toBeNull();
  });
});

/** What the plugin is given of a dev server: the HTTP server, the logger and the plugins. */
function devServer(
  httpServer: Server | null,
  lines: string[],
  plugins: Plugin[] = [],
): ViteDevServer {
  // justification: the plugin reads only these members of a dev server.
  return {
    httpServer,
    config: {
      logger: {
        info: (message: string) => lines.push(message),
        warn: (message: string) => lines.push(`warn:${message}`),
      },
      plugins,
    },
  } as unknown as ViteDevServer;
}

/** A stand-in for the hearth plugin, whose `launchLink` answers `link` (or rejects with it). */
function hearthStandIn(
  link: (base: string) => Promise<string>,
  bases: string[] = [],
): Plugin {
  return {
    name: HEARTH_PLUGIN,
    api: {
      launchLink: (base: string) => {
        bases.push(base);
        return link(base);
      },
    },
  };
}

/** Listen on a port the system picks, run `check` with it, and close. */
async function listening(
  http: Server,
  check: (port: number) => Promise<void>,
): Promise<void> {
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  try {
    await check((http.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((done) => http.close(() => done()));
  }
}

/** Wait until `lines` holds `count` lines, or fail. */
async function lineCount(lines: string[], count: number): Promise<void> {
  for (let tries = 0; lines.length < count && tries < 200; tries++)
    await new Promise((done) => setTimeout(done, 5));
}

function configure(server: ViteDevServer): void {
  const hook = printDashboardUrlPlugin().configureServer;
  if (typeof hook !== "function")
    throw new Error("the plugin has no configureServer hook");
  // justification: Vite calls the hook with the plugin as `this`; this one does not use it.
  void (hook as (server: ViteDevServer) => unknown)(server);
}

describe("the dev server says where the dashboard is once it listens", () => {
  test("one Dashboard ready line, with the port the server actually bound, only once it is listening", async () => {
    const lines: string[] = [];
    const http = createServer();
    configure(devServer(http, lines));
    expect(lines).toEqual([]);

    // Port 0: the system picks one, as Vite does when the asked-for port is taken.
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    try {
      const { port } = http.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      const ready = lines.filter((line) => line.includes("Dashboard ready"));
      expect(ready).toEqual([`  Dashboard ready: http://localhost:${port}/`]);
    } finally {
      await new Promise<void>((done) => http.close(() => done()));
    }
  });

  test("a dev server with no HTTP server (middleware mode) prints nothing", () => {
    const lines: string[] = [];
    configure(devServer(null, lines));
    expect(lines).toEqual([]);
  });

  test("with the hearth plugin there, the line is the launch link minted for the URL the server bound, then how long it lasts and how to get another", async () => {
    const lines: string[] = [];
    const bases: string[] = [];
    const http = createServer();
    configure(
      devServer(http, lines, [
        hearthStandIn(
          async (base) => `${base}#launch=${"c".repeat(64)}`,
          bases,
        ),
      ]),
    );
    await listening(http, async (port) => {
      await lineCount(lines, 2);
      expect(bases).toEqual([`http://localhost:${port}/`]);
      expect(lines).toEqual([
        `  Dashboard ready: http://localhost:${port}/#launch=${"c".repeat(64)}`,
        LAUNCH_NOTE,
      ]);
    });
    expect(LAUNCH_NOTE).toBe(
      "  (a one-time link, good for 5 minutes; for a new one: bun run dashboard:open)",
    );
  });

  test("when no launch link can be minted, the line is the bare URL and a warning says why and names the open command", async () => {
    const lines: string[] = [];
    const http = createServer();
    configure(
      devServer(http, lines, [
        hearthStandIn(async () => {
          throw new Error("the control plane's token file could not be read");
        }),
      ]),
    );
    await listening(http, async (port) => {
      await lineCount(lines, 2);
      expect(lines).toEqual([
        `  Dashboard ready: http://localhost:${port}/`,
        "warn:  No launch link (the control plane's token file could not be read): the page reads, but sends no operator action until it is opened from one. For one: bun run dashboard:open",
      ]);
    });
  });
});

describe("announceDashboard", () => {
  test("without the hearth plugin, one line with the bare URL", async () => {
    const lines: string[] = [];
    await announceDashboard("http://localhost:1/", null, {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(`warn:${message}`),
    });
    expect(lines).toEqual(["  Dashboard ready: http://localhost:1/"]);
  });
});

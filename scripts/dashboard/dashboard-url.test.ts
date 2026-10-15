import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { dashboardUrl, printDashboardUrlPlugin } from "./dashboard-url";

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

/** What the plugin is given of a dev server: the HTTP server and the logger. */
function devServer(httpServer: Server | null, lines: string[]): ViteDevServer {
  // justification: the plugin reads only these two members of a dev server.
  return {
    httpServer,
    config: {
      logger: { info: (message: string) => lines.push(message) },
    },
  } as unknown as ViteDevServer;
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
});

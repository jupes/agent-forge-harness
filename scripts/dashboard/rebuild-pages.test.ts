import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Plugin } from "vite";
import { REBUILD_PATH, rebuildPagesPlugin } from "./rebuild-pages";

/**
 * Stands in for `scripts/build-pages.ts` (no bd, no tracker): logs "start",
 * waits until the test writes `release` (or gives up after `waitMs` and exits
 * 1), then logs "end". A build that blocks the dev server's thread can never
 * be released, because the test that would release it runs on that thread.
 */
const GATE = `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [box, waitMs] = process.argv.slice(2);
appendFileSync(join(box, "runs.log"), "start\\n");
const deadline = Date.now() + Number(waitMs);
while (!existsSync(join(box, "release"))) {
  if (Date.now() > deadline) {
    console.error("gate: not released");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
appendFileSync(join(box, "runs.log"), "end\\n");
console.log("gate: built");
`;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Answers `/__ping` at once: what any other request to the dev server needs. */
function pingPlugin(): Plugin {
  return {
    name: "ping",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__ping") {
          next();
          return;
        }
        res.end("pong");
      });
    },
  };
}

/** Records what the server pushes to the page over the HMR socket. */
function recordPushes(pushed: unknown[]): Plugin {
  return {
    name: "record-pushes",
    configureServer(server) {
      const send = server.ws.send.bind(server.ws);
      server.ws.send = ((...args: Parameters<typeof send>) => {
        pushed.push(args[0]);
        send(...args);
      }) as typeof server.ws.send;
    },
  };
}

/** A port the system just handed out, so no other dev server is on it. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

interface Fixture {
  url: string;
  root: string;
  box: string;
  pushed: unknown[];
}

async function fixture(
  options: {
    initialBuild?: boolean;
    beadsDir?: boolean;
    timeoutMs?: number;
    waitMs?: number;
  } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "af-rebuild-root-"));
  const box = mkdtempSync(join(tmpdir(), "af-rebuild-box-"));
  writeFileSync(join(box, "gate.mjs"), GATE);
  if (options.beadsDir) mkdirSync(join(root, ".beads"));
  const pushed: unknown[] = [];
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      // Vite reads port 0 as "the default, 5173, or the next free one", a
      // range other dev servers on this machine use too.
      port: await freePort(),
      strictPort: true,
      // No file watching of Vite's own: only the plugin's pushes are recorded.
      watch: null,
    },
    plugins: [
      recordPushes(pushed),
      pingPlugin(),
      rebuildPagesPlugin({
        root,
        command: {
          file: process.execPath,
          args: [join(box, "gate.mjs"), box, String(options.waitMs ?? 3000)],
        },
        initialBuild: options.initialBuild ?? false,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      }),
    ],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("no address");
  cleanup.push(async () => {
    // Let a waiting gate finish rather than linger until its deadline.
    writeFileSync(join(box, "release"), "");
    await vite.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(box, { recursive: true, force: true, maxRetries: 3 });
  });
  return { url: `http://127.0.0.1:${address.port}`, root, box, pushed };
}

function runs(box: string): string[] {
  const log = join(box, "runs.log");
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
}

async function waitFor(
  what: string,
  done: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const release = (box: string): void => writeFileSync(join(box, "release"), "");

const reloads = (pushed: unknown[]): number =>
  pushed.filter(
    (p) =>
      typeof p === "object" &&
      p !== null &&
      (p as { type?: unknown }).type === "full-reload",
  ).length;

describe("rebuild-pages endpoint", () => {
  test("while a rebuild runs, the dev server answers another request; the POST is answered ok when the build finishes", async () => {
    const { url, box } = await fixture();

    const post = fetch(`${url}${REBUILD_PATH}`, { method: "POST" });
    await waitFor("the build to start", () => runs(box).includes("start"));
    const ping = await fetch(`${url}/__ping`);
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("pong");
    expect(runs(box)).toEqual(["start"]);

    release(box);
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(runs(box)).toEqual(["start", "end"]);
  });

  test("a build that fails answers 500 with the build's output", async () => {
    const { url } = await fixture({ waitMs: 0 });

    const res = await fetch(`${url}${REBUILD_PATH}`, { method: "POST" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("gate: not released");
  });

  test("a build that runs past the time limit is stopped and answered as failed, and the next POST starts a new build", async () => {
    // Long enough for a fresh bun process to start and finish under load.
    const { url, box } = await fixture({ timeoutMs: 2_000, waitMs: 10_000 });

    const first = await fetch(`${url}${REBUILD_PATH}`, { method: "POST" });
    expect(first.status).toBe(500);
    expect(((await first.json()) as { error: string }).error).toContain(
      "did not finish in",
    );

    release(box);
    const second = await fetch(`${url}${REBUILD_PATH}`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(runs(box)).toEqual(["start", "start", "end"]);
  }, 15_000);

  test("GET is refused with 405 and starts no build", async () => {
    const { url, box } = await fixture();

    const res = await fetch(`${url}${REBUILD_PATH}`);

    expect(res.status).toBe(405);
    expect(runs(box)).toEqual([]);
  });
});

describe("rebuilds the dev server starts on its own", () => {
  test("the server listens while its first build is still running, and tells the page to reload when that build finishes", async () => {
    const { url, box, pushed } = await fixture({ initialBuild: true });

    await waitFor("the first build to start", () =>
      runs(box).includes("start"),
    );
    expect((await fetch(`${url}/__ping`)).status).toBe(200);
    expect(runs(box)).toEqual(["start"]);
    expect(reloads(pushed)).toBe(0);

    release(box);
    await waitFor("a full-reload push", () => reloads(pushed) === 1);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 15_000);

  test("a file change under .beads/ starts a rebuild without blocking the server, and the page is told to reload after it", async () => {
    const { url, root, box, pushed } = await fixture({ beadsDir: true });

    writeFileSync(join(root, ".beads", "issues.jsonl"), "{}\n");
    await waitFor("the rebuild to start", () => runs(box).includes("start"));
    expect((await fetch(`${url}/__ping`)).status).toBe(200);
    expect(reloads(pushed)).toBe(0);

    release(box);
    await waitFor("a full-reload push", () => reloads(pushed) === 1);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 15_000);
});

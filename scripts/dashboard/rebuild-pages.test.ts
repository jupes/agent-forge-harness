import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  connect as connectSocket,
  createServer as createNetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Plugin } from "vite";
import { OPERATOR_HEADER } from "../hearth/paths";
import { startTestHearth, type TestHearth } from "../hearth/testing";
import { hearthPlugin } from "../hearth/vite-plugin";
import { REBUILD_PATH, rebuildPagesPlugin } from "./rebuild-pages";
import { SNAPSHOT_REBUILT_EVENT } from "./snapshot-events";

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

/**
 * Sends one request to `127.0.0.1` from the source address `127.0.0.2`, and
 * prints the address it sent from, the status and the body. Run by Node: Bun
 * ignores `localAddress`, so under Bun the request would come from 127.0.0.1.
 * The loopback check accepts only 127.0.0.1, ::1 and ::ffff:127.0.0.1, so to
 * it this is a client on another machine.
 */
const OTHER_PEER = `
import { connect } from "node:net";
const [port, method, target] = process.argv.slice(2);
const socket = connect({ host: "127.0.0.1", port: Number(port), localAddress: "127.0.0.2" });
let from = null;
let answer = "";
socket.on("connect", () => {
  from = socket.localAddress;
  socket.write(method + " " + target + " HTTP/1.1\\r\\nHost: 127.0.0.1:" + port + "\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n");
});
let done = false;
// The answer is printed once it is whole: the server may keep the socket open.
const finish = () => {
  const split = answer.indexOf("\\r\\n\\r\\n");
  if (split === -1) return false;
  const head = answer.slice(0, split);
  let body = answer.slice(split + 4);
  const length = /\\r\\ncontent-length: *(\\d+)/i.exec(head);
  if (length) {
    if (Buffer.byteLength(body) < Number(length[1])) return false;
  } else if (/\\r\\ntransfer-encoding: *chunked/i.test(head)) {
    if (!body.endsWith("0\\r\\n\\r\\n")) return false;
    let plain = "";
    for (let at = 0; ; ) {
      const end = body.indexOf("\\r\\n", at);
      const size = Number.parseInt(body.slice(at, end), 16);
      if (!size) break;
      plain += body.slice(end + 2, end + 2 + size);
      at = end + 2 + size + 2;
    }
    body = plain;
  } else return false;
  const status = Number(/^HTTP\\/1\\.[01] (\\d{3})/.exec(head)?.[1] ?? 0);
  console.log(JSON.stringify({ from, status, body }));
  done = true;
  socket.destroy();
  return true;
};
socket.on("data", (chunk) => { answer += chunk.toString("utf8"); finish(); });
socket.on("error", (error) => { if (!done) { console.log(JSON.stringify({ error: error.message })); process.exit(1); } });
socket.on("close", () => { if (!done) console.log(JSON.stringify({ from, status: 0, body: answer })); });
`;

const NODE = Bun.which("node");

/** One request to the dev server from 127.0.0.2, made by a Node child process. */
async function requestFromOtherPeer(
  box: string,
  port: number,
  method: string,
  target: string,
): Promise<{ from: string | null; status: number; body: string }> {
  if (!NODE) throw new Error("node is not on PATH");
  const script = join(box, "other-peer.mjs");
  writeFileSync(script, OTHER_PEER);
  // Asynchronous: the dev server answering it runs in this process.
  const child = Bun.spawn([NODE, script, String(port), method, target], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  try {
    return JSON.parse(out) as {
      from: string | null;
      status: number;
      body: string;
    };
  } catch {
    throw new Error(`the Node peer printed no answer: ${out}${err}`);
  }
}

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

/**
 * Records what the server pushes to the page over the HMR socket. A custom
 * event (`send(name, data)`) is recorded in the shape it travels in.
 */
function recordPushes(pushed: unknown[]): Plugin {
  return {
    name: "record-pushes",
    configureServer(server) {
      const send = server.ws.send.bind(server.ws) as (
        ...args: unknown[]
      ) => void;
      server.ws.send = ((...args: unknown[]) => {
        pushed.push(
          typeof args[0] === "string"
            ? { type: "custom", event: args[0], data: args[1] }
            : args[0],
        );
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
  port: number;
  root: string;
  box: string;
  pushed: unknown[];
  /** How many times the hearth plugin has asked for the hearth's port. */
  ensured: () => number;
  /** Close the dev server (cleanup closes it too). */
  close: () => Promise<void>;
}

async function fixture(
  options: {
    initialBuild?: boolean;
    beadsDir?: boolean;
    timeoutMs?: number;
    waitMs?: number;
    /**
     * Mount the hearth plugin too, proxying to this hearth and wired to the
     * rebuild as `vite.dashboard.config.ts` wires it.
     */
    hearth?: TestHearth;
  } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "af-rebuild-root-"));
  const box = mkdtempSync(join(tmpdir(), "af-rebuild-box-"));
  writeFileSync(join(box, "gate.mjs"), GATE);
  if (options.beadsDir) mkdirSync(join(root, ".beads"));
  const pushed: unknown[] = [];
  const rebuildPages = rebuildPagesPlugin({
    root,
    command: {
      file: process.execPath,
      args: [join(box, "gate.mjs"), box, String(options.waitMs ?? 3000)],
    },
    initialBuild: options.initialBuild ?? false,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
  let ensured = 0;
  const { hearth } = options;
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
      rebuildPages,
      ...(hearth
        ? [
            hearthPlugin(root, {
              home: hearth.home,
              supervisor: {
                ensure: async () => {
                  ensured++;
                  return hearth.hearth.port;
                },
                stopIfOwner: async () => {},
              },
              onTrackerWrite: () => rebuildPages.api.rebuildSoon(),
              trackerWritePollMs: 50,
            }),
          ]
        : []),
    ],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("no address");
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= vite.close();
    return closing;
  };
  cleanup.push(async () => {
    // Let a waiting gate finish rather than linger until its deadline.
    writeFileSync(join(box, "release"), "");
    await close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(box, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    root,
    box,
    pushed,
    ensured: () => ensured,
    close,
  };
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

/** Pushes that tell the page the snapshot was rebuilt. */
const rebuiltNotices = (pushed: unknown[]): number =>
  pushed.filter(
    (p) =>
      typeof p === "object" &&
      p !== null &&
      (p as { type?: unknown }).type === "custom" &&
      (p as { event?: unknown }).event === SNAPSHOT_REBUILT_EVENT,
  ).length;

/**
 * One request over a socket of its own, with exactly the header lines given
 * (repeats included): `fetch` decides some headers itself. Answers the status
 * and the body once the answer is whole.
 */
function rawRequest(
  port: number,
  head: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    let answer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no whole answer: ${answer}`));
    }, 10_000);
    socket.on("connect", () =>
      socket.write(`${head}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("utf8");
      const split = answer.indexOf("\r\n\r\n");
      if (split === -1) return;
      const length = /\r\ncontent-length: *(\d+)/i.exec(answer.slice(0, split));
      const body = answer.slice(split + 4);
      if (!length || Buffer.byteLength(body) < Number(length[1])) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0),
        body,
      });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

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

  test.skipIf(!NODE)(
    "a POST sent from 127.0.0.1 is served; a POST and a GET sent from 127.0.0.2 are answered 403 and start no build",
    async () => {
      const { url, port, box } = await fixture();

      const post = await requestFromOtherPeer(box, port, "POST", REBUILD_PATH);
      expect(post.from).toBe("127.0.0.2");
      expect(post.status).toBe(403);
      expect(JSON.parse(post.body)).toEqual({
        ok: false,
        error: "The rebuild is available only from this machine",
      });
      const get = await requestFromOtherPeer(box, port, "GET", REBUILD_PATH);
      expect(get.status).toBe(403);

      // Had a refused request started a build, the log would show two builds.
      release(box);
      const local = await fetch(`${url}${REBUILD_PATH}`, { method: "POST" });
      expect(local.status).toBe(200);
      expect(runs(box)).toEqual(["start", "end"]);
    },
    15_000,
  );

  test("from 127.0.0.1, a POST with a foreign Origin, with Sec-Fetch-Site: cross-site, with a Host that is not loopback, or with Origin sent twice is answered 403 and starts no build; one from the page's own origin is served", async () => {
    const { port, box } = await fixture();
    const host = `127.0.0.1:${port}`;
    const own = `http://${host}`;
    const refused = [
      ["a foreign Origin", `Host: ${host}\r\nOrigin: https://evil.example`],
      [
        "Sec-Fetch-Site: cross-site",
        `Host: ${host}\r\nSec-Fetch-Site: cross-site`,
      ],
      [
        "a foreign Origin with Sec-Fetch-Site: cross-site",
        `Host: ${host}\r\nOrigin: https://evil.example\r\nSec-Fetch-Site: cross-site`,
      ],
      ["a Host that is not loopback", `Host: evil.example:${port}`],
      [
        "Origin sent twice",
        `Host: ${host}\r\nOrigin: https://evil.example\r\nOrigin: ${own}`,
      ],
    ];
    for (const [label, headers] of refused) {
      const answer = await rawRequest(
        port,
        `POST ${REBUILD_PATH} HTTP/1.1\r\n${headers}`,
      );
      expect({ label, status: answer.status }).toEqual({ label, status: 403 });
      expect(JSON.parse(answer.body)).toEqual({
        ok: false,
        error: "The rebuild is answered only to the dashboard's own page",
      });
    }

    // Had a refused request started a build, the log would show two builds.
    release(box);
    const served = await rawRequest(
      port,
      `POST ${REBUILD_PATH} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${own}\r\nSec-Fetch-Site: same-origin`,
    );
    expect(served.status).toBe(200);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 15_000);
});

describe("rebuilds the dev server starts on its own", () => {
  test("the server listens while its first build is still running, and tells the page the snapshot was rebuilt when that build finishes, without a full reload", async () => {
    const { url, box, pushed } = await fixture({ initialBuild: true });

    await waitFor("the first build to start", () =>
      runs(box).includes("start"),
    );
    expect((await fetch(`${url}/__ping`)).status).toBe(200);
    expect(runs(box)).toEqual(["start"]);
    expect(rebuiltNotices(pushed)).toBe(0);

    release(box);
    await waitFor(
      "a snapshot-rebuilt push",
      () => rebuiltNotices(pushed) === 1,
    );
    expect(reloads(pushed)).toBe(0);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 15_000);

  test("a file change under .beads/ starts a rebuild without blocking the server, and the page is told the snapshot was rebuilt after it, without a full reload", async () => {
    const { url, root, box, pushed } = await fixture({ beadsDir: true });

    writeFileSync(join(root, ".beads", "issues.jsonl"), "{}\n");
    await waitFor("the rebuild to start", () => runs(box).includes("start"));
    expect((await fetch(`${url}/__ping`)).status).toBe(200);
    expect(rebuiltNotices(pushed)).toBe(0);

    release(box);
    await waitFor(
      "a snapshot-rebuilt push",
      () => rebuiltNotices(pushed) === 1,
    );
    expect(reloads(pushed)).toBe(0);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 15_000);

  test("a claim sent through the dashboard's proxy to the hearth starts a rebuild with no .beads/ directory, and the page is told the snapshot was rebuilt after it, without a full reload", async () => {
    // A hermetic hearth: its own ledger, and a bd that records and agrees.
    const hearth = await startTestHearth();
    cleanup.push(() => hearth.close());
    const { url, box, pushed, ensured } = await fixture({ hearth });
    // One ask at start, then one per poll; polls run one at a time, so a
    // third ask means the first poll, which finds where following begins, is done.
    await waitFor("the first poll", () => ensured() >= 3);
    expect(runs(box)).toEqual([]);

    const claim = await fetch(`${url}/__agent-forge/beads/demo-task/claim`, {
      method: "POST",
      headers: {
        Origin: url,
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: hearth.hearth.token,
      },
      body: "{}",
    });
    expect(claim.status).toBe(200);
    expect(hearth.events(["bead.transitioned"])).toHaveLength(1);

    await waitFor("the rebuild to start", () => runs(box).includes("start"));
    expect((await fetch(`${url}/__ping`)).status).toBe(200);
    expect(rebuiltNotices(pushed)).toBe(0);

    release(box);
    await waitFor(
      "a snapshot-rebuilt push",
      () => rebuiltNotices(pushed) === 1,
    );
    expect(reloads(pushed)).toBe(0);
    expect(runs(box)).toEqual(["start", "end"]);
  }, 20_000);

  test("once the dev server has closed, the hearth plugin stops polling, and a claim made then starts no build", async () => {
    const hearth = await startTestHearth();
    cleanup.push(() => hearth.close());
    const { box, ensured, close } = await fixture({ hearth });
    await waitFor("the first poll", () => ensured() >= 3);

    await close();
    const asked = ensured();
    const claim = await fetch(`${hearth.api}/beads/demo-task/claim`, {
      method: "POST",
      headers: hearth.headers(hearth.hearth.token),
      body: "{}",
    });
    expect(claim.status).toBe(200);
    // Twenty poll intervals, and the rebuild's own pause twice over.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(ensured()).toBe(asked);
    expect(runs(box)).toEqual([]);
  }, 20_000);
});

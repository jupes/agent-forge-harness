import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import {
  type DesktopHost,
  startDesktopHost,
} from "../../scripts/hearth/desktop-host";
import { ensurePrivateHome } from "../../scripts/hearth/home-guard";
import { writeOwnerOnly } from "../../scripts/hearth/token";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { DASHBOARD_PORT, HEARTH_HOME } from "../e2e/servers";
import { ASSETS, fixtureEnvironment, MANIFEST, ROOT } from "./environment";

ensurePrivateHome(HEARTH_HOME);
mkdirSync(resolve(ROOT, ".git"), { recursive: true });
const canonicalRoot = resolveCheckout(ROOT).workspace;
const environment = fixtureEnvironment();
const controlPath = "/__desktop-restart-fixture/restart-host";
const forkControlPath = "/__desktop-restart-fixture/restart-host-fork";
const controlHeader = "x-agent-forge-fixture-secret";
const controlSecret = randomBytes(32).toString("hex");
const replacementProof = join(
  HEARTH_HOME,
  "desktop-host-replacement-proof.json",
);
const forkReplacementProof = join(
  HEARTH_HOME,
  "desktop-host-fork-replacement-proof-v2.json",
);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, environment);
const build = Bun.spawn(
  [
    process.execPath,
    "run",
    "dashboard:build",
    "--mode",
    "desktop",
    "--outDir",
    ASSETS,
    "--emptyOutDir",
  ],
  {
    env: { ...process.env, DASHBOARD_NO_BUILD: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 90000,
  },
);
const [code, error] = await Promise.all([
  build.exited,
  new Response(build.stderr).text(),
]);
if (code)
  throw new Error(`Isolated desktop asset build failed: ${error.slice(-4000)}`);
let host = await startDesktopHost({
  root: canonicalRoot,
  home: HEARTH_HOME,
  assetsRoot: ASSETS,
  port: DASHBOARD_PORT,
  hearthCommand: [process.execPath, resolve("scripts/hearth/server.ts")],
});
let hostCreatedAtMs = Date.now();
const publishManifest = () =>
  writeOwnerOnly(
    MANIFEST,
    JSON.stringify({
      root: canonicalRoot,
      owner: host.owner,
      url: host.url,
      fixtureControl: { port: controlPort, secret: controlSecret },
    }),
  );
let controlPort = 0;
const control = createServer((request, response) => {
  void handleControl(request, response);
});
const respond = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
};
async function ownedHearthPid(current: DesktopHost): Promise<number> {
  const health = await fetch(new URL("/__agent-forge/health", current.url), {
    signal: AbortSignal.timeout(5_000),
  });
  const envelope = (await health.json()) as unknown;
  const data = record(envelope)?.["data"];
  const pid = record(data)?.["pid"];
  if (
    !health.ok ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  )
    throw new Error("Owned hearth health did not prove its process id.");
  return pid;
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function isForkReplacementGeneration(value: unknown): boolean {
  const item = record(value);
  return (
    item !== null &&
    Object.keys(item).length === 10 &&
    Number.isSafeInteger(item["oldDesktopHostPort"]) &&
    Number.isSafeInteger(item["newDesktopHostPort"]) &&
    Number.isSafeInteger(item["controlPort"]) &&
    Number.isSafeInteger(item["oldOwnedHearthPid"]) &&
    Number.isSafeInteger(item["newOwnedHearthPid"]) &&
    Number.isSafeInteger(item["oldHostCreatedAtMs"]) &&
    Number.isSafeInteger(item["newHostCreatedAtMs"]) &&
    Number.isSafeInteger(item["replacedAtMs"]) &&
    typeof item["oldHostOwner"] === "string" &&
    typeof item["newHostOwner"] === "string" &&
    item["oldDesktopHostPort"] !== item["newDesktopHostPort"] &&
    item["oldOwnedHearthPid"] !== item["newOwnedHearthPid"] &&
    (item["oldHostCreatedAtMs"] as number) <
      (item["newHostCreatedAtMs"] as number) &&
    (item["newHostCreatedAtMs"] as number) <= (item["replacedAtMs"] as number)
  );
}
const repeatedHeader = (request: IncomingMessage, target: string) => {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === target) count++;
  return count > 1;
};
let restartInProgress = false,
  singleRestartCount = 0,
  forkRestartCount = 0,
  closing = false,
  replacementPromise: Promise<void> | null = null;
async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (closing) {
    request.resume();
    respond(response, 503, {
      ok: false,
      data: null,
      error: "Fixture control is closing.",
    });
    return;
  }
  const address = control.address();
  const expectedHost =
    address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
  const received = request.headers[controlHeader];
  const supplied = typeof received === "string" ? Buffer.from(received) : null;
  const expected = Buffer.from(controlSecret);
  const authorized =
    supplied !== null &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected);
  if (
    request.method !== "POST" ||
    (request.url !== controlPath && request.url !== forkControlPath) ||
    request.headers.host !== expectedHost ||
    !["127.0.0.1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress ?? "",
    ) ||
    request.headers.origin !== undefined ||
    request.headers["sec-fetch-site"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    ["host", "origin", "sec-fetch-site", "content-length", controlHeader].some(
      (name) => repeatedHeader(request, name),
    ) ||
    !authorized
  ) {
    request.resume();
    respond(response, 403, {
      ok: false,
      data: null,
      error: "Fixture control refused.",
    });
    return;
  }
  const forkFlow = request.url === forkControlPath;
  if (
    restartInProgress ||
    (forkFlow ? forkRestartCount >= 2 : singleRestartCount !== 0)
  ) {
    request.resume();
    respond(response, 409, {
      ok: false,
      data: null,
      error: "Fixture restart unavailable.",
    });
    return;
  }
  let bodyBytes = 0;
  request.on("data", (chunk: Buffer) => {
    bodyBytes += chunk.byteLength;
  });
  request.on("end", () => {
    if (bodyBytes !== 0) {
      respond(response, 400, {
        ok: false,
        data: null,
        error: "Fixture control requires an empty request.",
      });
      return;
    }
    if (closing) {
      respond(response, 503, {
        ok: false,
        data: null,
        error: "Fixture control is closing.",
      });
      return;
    }
    restartInProgress = true;
    if (forkFlow) forkRestartCount++;
    else singleRestartCount++;
    replacementPromise = (async () => {
      const previous = host;
      const oldPort = Number(new URL(previous.url).port);
      const oldPid = await ownedHearthPid(previous);
      // The host drains owned sockets; supervisor stop is bounded, and ensure
      // gives the replacement hearth at most its configured 20 second start window.
      await previous.close();
      if (closing)
        throw new Error("Fixture is closing after the old host stopped.");
      const next = await startDesktopHost({
        root: canonicalRoot,
        home: HEARTH_HOME,
        assetsRoot: ASSETS,
        port: 0,
        hearthCommand: [process.execPath, resolve("scripts/hearth/server.ts")],
      });
      try {
        if (closing) {
          await next.close();
          throw new Error(
            "Fixture is closing before the replacement is published.",
          );
        }
        const newPort = Number(new URL(next.url).port);
        const newPid = await ownedHearthPid(next);
        const nextHostCreatedAtMs = Date.now();
        if (
          oldPort < 1 ||
          newPort < 1 ||
          oldPort === newPort ||
          oldPid === newPid
        )
          throw new Error("The replaced desktop host identity was not unique.");
        if (forkFlow) {
          let generations: unknown[] = [];
          if (existsSync(forkReplacementProof)) {
            let prior: unknown;
            try {
              prior = JSON.parse(await Bun.file(forkReplacementProof).text());
            } catch {
              throw new Error("The Fork replacement proof is invalid.");
            }
            const priorRecord = record(prior);
            if (
              priorRecord?.["version"] !== 2 ||
              !Array.isArray(priorRecord["generations"]) ||
              priorRecord["generations"].length !== forkRestartCount - 1 ||
              !priorRecord["generations"].every(isForkReplacementGeneration)
            )
              throw new Error("The Fork replacement proof is inconsistent.");
            generations = priorRecord["generations"];
          } else if (forkRestartCount !== 1) {
            throw new Error("The Fork replacement proof is missing.");
          }
          const all = [
            ...generations,
            {
              oldDesktopHostPort: oldPort,
              newDesktopHostPort: newPort,
              controlPort,
              oldOwnedHearthPid: oldPid,
              newOwnedHearthPid: newPid,
              oldHostCreatedAtMs: hostCreatedAtMs,
              newHostCreatedAtMs: nextHostCreatedAtMs,
              oldHostOwner: previous.owner,
              newHostOwner: next.owner,
              replacedAtMs: Date.now(),
            },
          ];
          const firstGeneration = record(all[0]);
          const hostPorts = [
            firstGeneration?.["oldDesktopHostPort"],
            ...all.map((item) => record(item)?.["newDesktopHostPort"]),
          ];
          const hostPids = [
            firstGeneration?.["oldOwnedHearthPid"],
            ...all.map((item) => record(item)?.["newOwnedHearthPid"]),
          ];
          const hostOwners = [
            firstGeneration?.["oldHostOwner"],
            ...all.map((item) => record(item)?.["newHostOwner"]),
          ];
          const continuous = all.every((item, index) => {
            if (index === 0) return true;
            const previousGeneration = record(all[index - 1]);
            const currentGeneration = record(item);
            return (
              previousGeneration?.["newDesktopHostPort"] ===
                currentGeneration?.["oldDesktopHostPort"] &&
              previousGeneration?.["newOwnedHearthPid"] ===
                currentGeneration?.["oldOwnedHearthPid"] &&
              previousGeneration?.["newHostOwner"] ===
                currentGeneration?.["oldHostOwner"] &&
              previousGeneration?.["newHostCreatedAtMs"] ===
                currentGeneration?.["oldHostCreatedAtMs"]
            );
          });
          if (
            all.length > 2 ||
            !all.every(isForkReplacementGeneration) ||
            new Set(hostPorts).size !== hostPorts.length ||
            new Set(hostPids).size !== hostPids.length ||
            new Set(hostOwners).size !== hostOwners.length ||
            !continuous ||
            all.some((item) => record(item)?.["controlPort"] !== controlPort) ||
            (all.length > 1 &&
              (firstGeneration?.["newDesktopHostPort"] !== oldPort ||
                firstGeneration?.["newOwnedHearthPid"] !== oldPid ||
                firstGeneration?.["newHostOwner"] !== previous.owner ||
                firstGeneration?.["newHostCreatedAtMs"] !== hostCreatedAtMs))
          )
            throw new Error("The Fork replacement proof exceeded its bound.");
          writeOwnerOnly(
            forkReplacementProof,
            JSON.stringify({ version: 2, generations: all }),
          );
        } else {
          if (singleRestartCount !== 1 || existsSync(replacementProof))
            throw new Error(
              "The replaced desktop host identity was not unique.",
            );
          writeOwnerOnly(
            replacementProof,
            JSON.stringify({
              oldDesktopHostPort: oldPort,
              newDesktopHostPort: newPort,
              controlPort,
              oldOwnedHearthPid: oldPid,
              newOwnedHearthPid: newPid,
            }),
          );
        }
        host = next;
        hostCreatedAtMs = nextHostCreatedAtMs;
        publishManifest();
      } catch (error) {
        host = previous;
        await next.close();
        throw error;
      }
      return;
    })();
    void replacementPromise
      .then(() => {
        respond(response, 200, {
          ok: true,
          data: { owner: host.owner, url: host.url },
          error: null,
        });
      })
      .catch(() => {
        respond(response, 503, {
          ok: false,
          data: null,
          error: "The owned desktop host could not be replaced.",
        });
      })
      .finally(() => {
        restartInProgress = false;
        replacementPromise = null;
      });
  });
}
try {
  await new Promise<void>((resolveListen, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", () => {
      control.removeListener("error", reject);
      const address = control.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture control did not bind a loopback port."));
        return;
      }
      controlPort = address.port;
      resolveListen();
    });
  });
  publishManifest();
} catch (error) {
  if (control.listening)
    await new Promise<void>((done) => control.close(() => done()));
  await host.close();
  throw error;
}
console.log("Isolated desktop restart fixture ready.");
const close = () => {
  if (closing) return;
  closing = true;
  void (async () => {
    if (replacementPromise) await replacementPromise.catch(() => {});
    if (control.listening)
      await new Promise<void>((done) => control.close(() => done()));
    await host.close();
    process.exit(0);
  })();
};
process.once("SIGTERM", close);
process.once("SIGINT", close);

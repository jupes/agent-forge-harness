import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COUNCIL_API, councilHttpHandler } from "./dashboard";
import { createCouncilService } from "./service";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "council-http-"));
  const service = createCouncilService({
    workspaceRoot: root,
    harnessRoot: resolve(import.meta.dir, "../.."),
    runsRoot: join(root, "runs"),
  });
  const handler = councilHttpHandler(service);
  const server: Server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server address");
  const url = `http://127.0.0.1:${address.port}${COUNCIL_API}`;
  cleanup.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  return { service, url };
}

async function envelope(response: Response): Promise<{
  ok: boolean;
  data: Record<string, unknown>;
  error: string | null;
}> {
  try {
    return await response.json();
  } catch {
    throw new Error("HTTP response is not a JSON envelope");
  }
}

test("local dashboard starts, streams, and replays a preserved council", async () => {
  const { service, url } = await fixture();
  const profiles = await envelope(await fetch(`${url}/profiles`));
  expect(profiles.ok).toBe(true);
  expect(Array.isArray(profiles.data)).toBe(true);
  const started = await envelope(
    await fetch(`${url}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceType: "text",
        source: "Evaluate this plan and record any missing evidence.",
        runId: "http-review",
      }),
    }),
  );
  expect(started.ok).toBe(true);
  expect(started.data.status).toBe("running");
  const finished = await service.wait("http-review");
  expect(finished.status).toBe("completed");
  const stream = await fetch(`${url}/runs/http-review/events`);
  const events = await stream.text();
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(events.match(/event: snapshot/g)).toHaveLength(1);
  expect(events).toContain('"status":"completed"');
  const replay = await envelope(await fetch(`${url}/runs/http-review`));
  expect(replay.data.run).toEqual(finished.run);
  const list = await envelope(await fetch(`${url}/runs`));
  expect(Array.isArray(list.data)).toBe(true);
  const duplicate = await envelope(
    await fetch(`${url}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceType: "text",
        source: "Do not overwrite",
        runId: "http-review",
      }),
    }),
  );
  expect(duplicate.ok).toBe(false);
}, 10000);

test("local dashboard refuses cross-origin requests and invalid bodies", async () => {
  const { url } = await fixture();
  expect(
    (
      await fetch(`${url}/profiles`, {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/profiles`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${url}/profiles`, { headers: { Host: "attacker.example" } }))
      .status,
  ).toBe(403);
  const invalid = await envelope(
    await fetch(`${url}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    }),
  );
  expect(invalid.ok).toBe(false);
  expect(invalid.error).toContain("valid JSON");
  const wrongType = await fetch(`${url}/runs`, {
    method: "POST",
    body: "not-json",
  });
  expect(wrongType.status).toBe(400);
  expect(
    (await fetch(`${url}/runs/missing`, { method: "DELETE" })).status,
  ).toBe(405);
});

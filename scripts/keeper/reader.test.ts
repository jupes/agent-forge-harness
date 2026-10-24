import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildChildEnv } from "../executors/env";
import { type LoopbackRequest, loopbackExchange } from "../hearth/loopback";
import { startTestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
  projectFixture,
} from "../projects/testing";
import { readKeeperProject } from "./project-read";
import { createKeeperReader } from "./reader";
import { parseKeeperReaderArgs } from "./reader-entry";
import { verifyKeeperReader } from "./verify-reader";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("the runtime verifier checks a real reader's sealed scope and shutdown", async () => {
  expect(
    await verifyKeeperReader([
      process.execPath,
      join(import.meta.dir, "reader-entry.ts"),
    ]),
  ).toEqual({
    oneReadonlyTool: true,
    projectScoped: true,
    scopeChangeRefused: true,
    noOperatorAction: true,
    childStopped: true,
  });
}, 25_000);

test("the model gets one sealed readonly tool with no token or action surface", async () => {
  const h = await startTestHearth();
  cleanup.push(() => h.close());
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const sent: LoopbackRequest[] = [];
  const server = createKeeperReader({
    origin: h.hearth.url,
    projectId: FIXTURE_PROJECT_ID,
    exchange: (request) => {
      sent.push(request);
      return loopbackExchange(request);
    },
  });
  const client = new Client({ name: "keeper-reader-test", version: "0" });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(far);
  await client.connect(near);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "read_project",
  ]);
  const result = await client.callTool({
    name: "read_project",
    arguments: { kind: "beads" },
  });
  expect(result.isError).not.toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("GET");
  expect(sent[0]?.target).toContain(
    `/projects/${FIXTURE_PROJECT_ID}/keeper/read?`,
  );
  expect(JSON.stringify(sent)).not.toContain(h.hearth.token);
  const count = sent.length;
  const blocked = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }).then(
      (value) => value.isError === true,
      () => true,
    );
  expect(await blocked("start_shift", {})).toBe(true);
  expect(
    await blocked("read_project", {
      kind: "beads",
      projectId: "another-project",
    }),
  ).toBe(true);
  expect(
    await blocked("read_project", { kind: "write", command: "start a shift" }),
  ).toBe(true);
  expect(sent).toHaveLength(count);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("the actual stdio reader speaks MCP and closes with its client without starting a model", async () => {
  const h = await startTestHearth();
  cleanup.push(() => h.close());
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(import.meta.dir, "reader-entry.ts"),
      "--origin",
      h.hearth.url,
      "--project",
      FIXTURE_PROJECT_ID,
    ],
    env: buildChildEnv(process.env, []),
    stderr: "pipe",
    maxBufferSize: 128_000,
  });
  const client = new Client({ name: "keeper-stdio-test", version: "0" });
  cleanup.push(() => client.close());
  await client.connect(transport);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "read_project",
  ]);
  const answer = await client.callTool({
    name: "read_project",
    arguments: { kind: "beads" },
  });
  expect(answer.isError).not.toBe(true);
  expect(JSON.stringify(answer)).toContain(FIXTURE_PROJECT_ID);
  expect(JSON.stringify(answer)).not.toContain(h.hearth.token);
  await client.close();
  expect(transport.pid).toBeNull();
  expect(h.events(["operator.action"])).toEqual([]);
});

test("reader launch rejects external origins, swapped projects and action-mode flags", () => {
  expect(() =>
    createKeeperReader({
      origin: "https://example.com",
      projectId: FIXTURE_PROJECT_ID,
    }),
  ).toThrow();
  expect(() =>
    parseKeeperReaderArgs([
      "--origin",
      "http://127.0.0.1:1234",
      "--project",
      FIXTURE_PROJECT_ID,
      "--operator",
      "true",
    ]),
  ).toThrow();
  expect(() =>
    parseKeeperReaderArgs([
      "--origin",
      "http://127.0.0.1:1234",
      "--project",
      "../foreign",
    ]),
  ).toThrow();
});

test("a swapped or malformed response never returns foreign bodies or error secrets to the model", async () => {
  const project = projectFixture("/served");
  const data = readKeeperProject(
    project,
    1,
    {
      workspace: "/served",
      asOf: project.updatedAt,
      issues: [],
      queue: [],
      sessions: [],
      sessionsComplete: true,
      problems: [],
    },
    { events: [], more: false },
    { kind: "beads" },
  );
  const responses = [
    {
      status: 200,
      body: JSON.stringify({
        ok: true,
        data: {
          ...data,
          scope: {
            ...data.scope,
            projectId: "project-5c2a18aa-fc27-4117-b3f0-941cc823713e",
          },
          records: [
            { id: "foreign", data: "SECRET_FOREIGN_BODY", truncated: false },
          ],
        },
        error: null,
      }),
    },
    { status: 200, body: '{"ok":true,"SECRET_BROKEN_BODY"' },
    {
      status: 503,
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "SECRET_ERROR_BODY",
      }),
    },
  ];
  const server = createKeeperReader({
    origin: "http://127.0.0.1:1234",
    projectId: FIXTURE_PROJECT_ID,
    exchange: async () => {
      const next = responses.shift();
      if (!next) throw new Error("No fixture response");
      return next;
    },
  });
  const client = new Client({ name: "keeper-scope-test", version: "0" });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(far);
  await client.connect(near);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  for (let index = 0; index < 3; index++) {
    const result = await client.callTool({
      name: "read_project",
      arguments: { kind: "beads" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});

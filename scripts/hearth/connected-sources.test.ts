import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { nativePhysicalPath } from "../native-realpath";
import { completeFixtureModel } from "../projects/complete-tracker-test-model";
import { projectWorkspaceRef } from "../projects/connected-source-common";
import { createWorkspaceSourceInstance } from "../projects/connected-source-instance";
import {
  authorizedSourcePreviewSchema,
  sourceAuthorizationReceiptSchema,
  sourceListSchema,
} from "../projects/connected-source-protocol";
import { createConnectedSources } from "../projects/connected-source-service";
import { workspaceSourceConnector } from "../projects/connected-source-transport";
import {
  scopeSaveReceiptSchema,
  scopeSaveSchema,
} from "../projects/scope-settings-protocol";
import { createScopeSettings } from "../projects/scope-settings-service";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { createOperatorApi } from "./api";
import { lockPath, tokenPath } from "./home";
import { ensurePrivateHome } from "./home-guard";
import { loopbackExchange } from "./loopback";
import {
  API_PREFIX,
  HEALTH_ROUTE,
  OPERATOR_HEADER,
  SURFACE_HEADER,
} from "./paths";
import { HEARTH_API_VERSION } from "./protocol";
import { connectedSourceRoutes } from "./routes/connected-sources";
import { scopeSettingsRoutes } from "./routes/scope-settings";
import { inertScopeAuditFixture } from "./routes/scope-settings-fixture";
import { writeOwnerOnly } from "./token";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(refuseAudit = false) {
  const temp = mkdtempSync(join(tmpdir(), "source-http-"));
  const home = join(temp, "home");
  ensurePrivateHome(home);
  for (const name of ["local", "remote"]) mkdirSync(join(temp, name));
  const local = nativePhysicalPath(join(temp, "local")),
    remote = nativePhysicalPath(join(temp, "remote"));
  const catalog = projectCatalogFixture(local);
  catalog.projects[0]!.workspaces.push({
    root: remote,
    repositories: [remote],
    epicIds: ["alpha-epic"],
  });
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const store = createProjectStore(home);
  let reads = 0,
    picks = 0,
    held: Promise<void> | undefined;
  const snapshot = completeFixtureModel({
    status: 0,
    stderr: "",
    stdout: [
      {
        id: "alpha-epic",
        title: "Private epic",
        issue_type: "epic",
        status: "open",
        priority: 2,
        labels: ["project:alpha"],
        description: "PRIVATE BODY MUST STAY IN SOURCE",
      },
      {
        id: "beta-epic",
        title: "Beta",
        issue_type: "epic",
        status: "open",
        priority: 2,
        labels: ["project:alpha"],
      },
      {
        id: "alpha-task",
        title: "Task",
        issue_type: "task",
        status: "open",
        priority: 2,
        labels: ["project:alpha"],
        dependencies: [
          {
            issue_id: "alpha-task",
            depends_on_id: "alpha-epic",
            type: "parent-child",
          },
        ],
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
  });
  const own = createWorkspaceSourceInstance({
    root: local,
    catalog: store.read,
    complete: async () => ({
      ...snapshot,
      identity: {
        database: "local_fixture",
        projectId: "22222222-2222-4222-8222-222222222222",
      },
    }),
  });
  const foreign = createWorkspaceSourceInstance({
    root: remote,
    catalog: store.read,
    complete: async () => {
      reads++;
      await held;
      return snapshot;
    },
  });
  const events: LedgerEventInput[] = [];
  const ledger = join(home, "source-audit.db");
  const sources = createConnectedSources({
    root: local,
    catalog: store.read,
    own,
    connect: workspaceSourceConnector(home),
    pick: async () => {
      expect(events.at(-1)?.payload).toMatchObject({
        action: "project.source.authorize",
      });
      picks++;
      return remote;
    },
  });
  const sourceSources = createConnectedSources({
    root: remote,
    catalog: store.read,
    own: foreign,
    connect: workspaceSourceConnector(home),
  });
  const servers: Server[] = [];
  const mount = async (
    root: string,
    instance: typeof own,
    service: typeof sources,
    token: string,
  ) => {
    const routes = connectedSourceRoutes(service, instance);
    const scope = createScopeSettings(home, service),
      scopeRoutes = scopeSettingsRoutes(scope);
    const api = createOperatorApi(
      {
        workspace: root,
        expectedToken: () => token,
        appendEvent: (event) => {
          if (refuseAudit)
            return { ok: false, error: "Fixture audit unavailable" };
          const result = appendEvent(event, { path: ledger });
          if (result.ok) events.push(event);
          return result;
        },
      },
      [
        ...routes.reads,
        ...routes.actions,
        scopeRoutes.save,
        scopeRoutes.original,
      ],
    );
    const server = createServer((req, res) => {
      if (req.url === HEALTH_ROUTE) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            data: { pid: process.pid, root, apiVersion: HEARTH_API_VERSION },
            error: null,
          }),
        );
        return;
      }
      void api.handle(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fixture port");
    writeOwnerOnly(
      lockPath(home, root),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        root,
        startedAt: "2026-11-09T00:00:00.000Z",
        tokenFile: tokenPath(home, root),
      }),
    );
    writeOwnerOnly(tokenPath(home, root), token);
    return address.port;
  };
  const foreignToken = "a".repeat(64),
    token = "b".repeat(64);
  const remotePort = await mount(remote, foreign, sourceSources, foreignToken);
  const port = await mount(local, own, sources, token);
  cleanup.push(async () => {
    sources.deactivate();
    sourceSources.deactivate();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    closeLedger(ledger);
    rmSync(temp, { recursive: true, force: true });
  });
  const ref = projectWorkspaceRef(FIXTURE_PROJECT_ID, remote),
    base = `/projects/${FIXTURE_PROJECT_ID}/settings/sources`;
  const request = async (path: string, body?: unknown, authorized = true) => {
    const answer = await loopbackExchange({
      port,
      method: body === undefined ? "GET" : "POST",
      target: API_PREFIX + path,
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        ...(authorized ? { [OPERATOR_HEADER]: token } : {}),
        [SURFACE_HEADER]: "ui",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 3000,
      maxBytes: 1024 * 1024,
    });
    let data: unknown;
    try {
      data = JSON.parse(answer.body);
    } catch {
      throw Error("Invalid fixture JSON");
    }
    return { ...answer, envelope: data };
  };
  const authorize = async () => {
    const input = {
      requestId: randomUUID(),
      workspaceRef: ref,
      expectedRevision: 1,
    };
    const answer = await request(base + "/authorize", input);
    expect(answer.status).toBe(200);
    const envelope = answer.envelope as { ok: boolean; data: unknown };
    expect(envelope.ok).toBe(true);
    return {
      input,
      receipt: sourceAuthorizationReceiptSchema.parse(envelope.data),
    };
  };
  return {
    home,
    store,
    audit: () => queryEvents({ workspace: local }, { path: ledger }),
    remote,
    remotePort,
    foreignToken,
    ref,
    base,
    request,
    authorize,
    foreign,
    sources,
    events,
    counters: () => ({ reads, picks }),
    hold: (value: Promise<void> | undefined) => {
      held = value;
    },
  };
}
test("workspace Source HTTP gates private reads and consent before any source read or chooser", async () => {
  const f = await fixture();
  for (const path of [
    "/workspace-source/identity",
    `/projects/${FIXTURE_PROJECT_ID}/settings/scope/requests/${randomUUID()}`,
    `/workspace-source/projects/${FIXTURE_PROJECT_ID}/preview?revision=1`,
    f.base,
    f.base + "/" + f.ref + "/preview?revision=1",
    f.base + "/requests/" + randomUUID(),
  ])
    expect((await f.request(path, undefined, false)).status).toBe(403);
  expect(
    (
      await f.request(
        f.base + "/authorize",
        { requestId: randomUUID(), workspaceRef: f.ref, expectedRevision: 1 },
        false,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        f.base + "/" + f.ref + "/revoke",
        { grantId: randomUUID() },
        false,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        `/projects/${FIXTURE_PROJECT_ID}/settings/scope`,
        {},
        false,
      )
    ).status,
  ).toBe(403);
  expect(f.counters()).toEqual({ reads: 0, picks: 0 });
  expect(f.events).toHaveLength(0);
  expect(
    (
      await f.request(
        f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
      )
    ).status,
  ).toBe(409);
  expect(f.counters().reads).toBe(0);
  const { input, receipt } = await f.authorize();
  expect(receipt.state).toBe("authorized");
  expect(f.counters().picks).toBe(1);
  const recovered = await f.request(f.base + "/requests/" + input.requestId);
  expect(recovered.status).toBe(200);
  expect(f.counters().picks).toBe(1);
  const preview = await f.request(
    f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
  );
  expect(preview.status).toBe(200);
  const body = preview.envelope as { ok: boolean; data: unknown };
  expect(body.ok).toBe(true);
  expect(authorizedSourcePreviewSchema.parse(body.data).scopeCount).toBe(2);
  expect(preview.body).not.toContain("PRIVATE BODY MUST STAY IN SOURCE");
  expect(f.counters().picks).toBe(1);
});
test("real Source transport permanently retires an observed token replacement, with fresh explicit regrant", async () => {
  const f = await fixture();
  await f.authorize();
  writeOwnerOnly(tokenPath(f.home, f.remote), "c".repeat(64));
  expect(
    (
      await f.request(
        f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
      )
    ).status,
  ).toBe(409);
  writeOwnerOnly(tokenPath(f.home, f.remote), f.foreignToken);
  const before = f.counters().reads;
  expect(
    (
      await f.request(
        f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
      )
    ).status,
  ).toBe(409);
  expect(f.counters().reads).toBe(before);
  await f.authorize();
  expect(
    (
      await f.request(
        f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
      )
    ).status,
  ).toBe(200);
  expect(f.counters().picks).toBe(2);
});
test("protected revocation fences a held real-loopback preview and source shutdown cannot publish late data", async () => {
  const f = await fixture();
  const { receipt } = await f.authorize();
  let release!: () => void;
  f.hold(
    new Promise<void>((done) => {
      release = done;
    }),
  );
  const before = f.counters().reads;
  const pending = f.request(
    f.base + "/" + f.ref + "/preview?revision=1&epicId=alpha-epic",
  );
  const deadline = Date.now() + 1000;
  while (f.counters().reads === before && Date.now() < deadline)
    await new Promise<void>((done) => setTimeout(done, 1));
  expect(f.counters().reads).toBeGreaterThan(before);
  expect(
    (
      await f.request(f.base + "/" + f.ref + "/revoke", {
        grantId: receipt.grantId,
      })
    ).status,
  ).toBe(200);
  f.foreign.deactivate();
  f.hold(undefined);
  release();
  expect((await pending).status).not.toBe(200);
  expect(f.counters().picks).toBe(1);
  expect(
    f
      .audit()
      .filter((event) => event.kind === "operator.action")
      .map((event) => event.payload.family),
  ).toEqual(["project-source-authorization", "project-source-revoke"]);
});

test("Scope delivery composes real protected HTTP, all-workspace fresh proof checks, catalog Save and exact original recovery", async () => {
  const f = await fixture();
  await f.authorize();
  const listAnswer = await f.request(f.base);
  const list = sourceListSchema.parse(
    (listAnswer.envelope as { data: unknown }).data,
  );
  const proofs = await Promise.all(
    list.workspaces.map(async (row) => {
      const answer = await f.request(
        f.base +
          "/" +
          row.workspaceRef +
          "/preview?revision=1&epicId=beta-epic",
      );
      expect(answer.status).toBe(200);
      return authorizedSourcePreviewSchema.parse(
        (answer.envelope as { data: unknown }).data,
      );
    }),
  );
  const request = scopeSaveSchema.parse({
    requestId: randomUUID(),
    controllerId: list.controllerId,
    expectedRevision: 1,
    workspaces: proofs.map((proof) => ({
      workspaceRef: proof.workspaceRef,
      epicIds: proof.epicIds,
      grantId: proof.grantId,
      sourceInstanceId: proof.instance.instanceId,
      trackerId: proof.instance.tracker.projectId,
      scopeCount: proof.scopeCount,
      scopeHash: proof.scopeHash,
    })),
  });
  const answer = await f.request(
    "/projects/" + FIXTURE_PROJECT_ID + "/settings/scope",
    request,
  );
  expect(answer.status).toBe(200);
  const receipt = scopeSaveReceiptSchema.parse(
    (answer.envelope as { data: unknown }).data,
  );
  expect(receipt.state).toBe("saved");
  expect(receipt.catalogRevision).toBe(2);
  expect(
    f.store.read().projects[0]!.workspaces.map((row) => row.epicIds),
  ).toEqual([["beta-epic"], ["beta-epic"]]);
  const original = await f.request(
    "/projects/" +
      FIXTURE_PROJECT_ID +
      "/settings/scope/requests/" +
      request.requestId,
  );
  expect(original.status).toBe(200);
  expect((original.envelope as { data: unknown }).data).toEqual(receipt);
  expect(f.counters().picks).toBe(1);
  const audits = f.audit().filter((event) => event.kind === "operator.action");
  expect(audits.map((event) => event.payload.family)).toEqual([
    "project-source-authorization",
    "project-scope-save",
  ]);
  expect(JSON.stringify(audits)).not.toContain(
    "PRIVATE BODY MUST STAY IN SOURCE",
  );
});

test("Source and Scope audit refusal reaches the gate with independent schema-valid fixtures and no source or native effects", async () => {
  const f = await fixture(true);
  const input = inertScopeAuditFixture(randomUUID());
  expect(
    (
      await f.request(
        "/projects/" + FIXTURE_PROJECT_ID + "/settings/scope",
        input,
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await f.request(f.base + "/authorize", {
        requestId: randomUUID(),
        workspaceRef: f.ref,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await f.request(f.base + "/" + f.ref + "/revoke", {
        grantId: randomUUID(),
      })
    ).status,
  ).toBe(503);
  expect(f.counters()).toEqual({ reads: 0, picks: 0 });
  expect(f.events).toHaveLength(0);
  expect(f.audit()).toEqual([]);
});

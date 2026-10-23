import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { conversationFile } from "../../conversations/paths";
import {
  createSessionLibrary,
  sessionLibraryFile,
} from "../../sessions/library";
import {
  sessionLibraryReadSchema,
  sessionTranscriptExportSchema,
} from "../../sessions/library-protocol";
import { sessionRegistryFile } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedOwnedSession } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("complete export and reversible archive use protected audited routes without touching private history or the original registry", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const path = `/projects/${session.projectId}/sessions/${session.id}`;
  const address = {
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  };
  const history = readFileSync(
    conversationFile(h.home, session.projectId, address),
  );
  const registry = readFileSync(sessionRegistryFile(h.home));
  for (const suffix of ["/export", "/archive"]) {
    expect(
      (await fetch(`${h.api}${path}${suffix}`, { headers: h.headers() }))
        .status,
    ).toBe(403);
  }
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  expect(
    (
      await fetch(`${h.api}${path}/archive`, {
        method: "POST",
        headers: h.headers(),
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  expect(existsSync(sessionLibraryFile(h.home))).toBe(false);
  expect(
    (
      await fetch(`${h.api}${path}/archive`, {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify({ ...input, stop: true }),
      })
    ).status,
  ).toBe(400);
  expect(h.events()).toHaveLength(0);
  const response = await fetch(`${h.api}${path}/export`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  const body: { ok: boolean; data: unknown } = await response.json();
  expect(body.ok).toBe(true);
  expect(sessionTranscriptExportSchema.safeParse(body.data).success).toBe(true);
  expect(JSON.stringify(body.data)).toContain("Historical private fixture");
  expect(h.events()).toHaveLength(0);
  const archived = await fetch(`${h.api}${path}/archive`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(input),
  });
  expect(archived.status).toBe(200);
  const result: { ok: boolean; data: unknown } = await archived.json();
  expect(result.ok).toBe(true);
  expect(sessionLibraryReadSchema.parse(result.data).entry).toMatchObject({
    archived: true,
    revision: 1,
  });
  expect(
    h.events().map((event) => ({ kind: event.kind, payload: event.payload })),
  ).toEqual([
    {
      kind: "operator.action",
      payload: {
        action: "session.archive",
        surface: "api",
        target: session.id,
      },
    },
  ]);
  const read = await fetch(
    `${h.api}${path}/archive?requestId=${input.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(read.status).toBe(200);
  const recovered: { data: unknown } = await read.json();
  expect(
    sessionLibraryReadSchema.parse(recovered.data).receipt?.original,
  ).toEqual(input);
  const listed = await fetch(
    `${h.api}/projects/${session.projectId}/session-library`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(listed.status).toBe(200);
  const text = await listed.text();
  expect(text).toContain(session.id);
  expect(text).not.toContain("Historical private fixture");
  expect(
    readFileSync(conversationFile(h.home, session.projectId, address)),
  ).toEqual(history);
  expect(readFileSync(sessionRegistryFile(h.home))).toEqual(registry);
  expect(
    createSessionLibrary({ root: h.root, home: h.home }).read(
      session.projectId,
      session.id,
    ).entry.archived,
  ).toBe(true);
});

test("library routes reject widened queries and same-project foreign-workspace reads or exact writes without exposing a transcript", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const path = `/projects/${session.projectId}/sessions/${session.id}`;
  for (const suffix of [
    "/export?partial=true",
    "/archive?requestId=no",
    "/archive?requestId=x&requestId=y",
  ]) {
    expect(
      (
        await fetch(`${h.api}${path}${suffix}`, {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);
  }
  const original = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  const library = createSessionLibrary({ root: h.root, home: h.home });
  await library.archive(session.projectId, session.id, original);
  const preferences = readFileSync(sessionLibraryFile(h.home));
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: [{ ...session, workspace: `${session.workspace}-foreign` }],
    }),
  );
  for (const suffix of [
    "/export",
    `/archive?requestId=${original.requestId}`,
  ]) {
    const response = await fetch(`${h.api}${path}${suffix}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("Historical private fixture");
  }
  expect(
    (
      await fetch(`${h.api}${path}/archive`, {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify(original),
      })
    ).status,
  ).toBe(409);
  expect(readFileSync(sessionLibraryFile(h.home))).toEqual(preferences);
});

import { afterEach, expect, test } from "bun:test";
import { ConversationError } from "../../conversations/error";
import { knowledgeReceiptSchema } from "../../projects/knowledge-protocol";
import type { createKnowledgeService } from "../../projects/knowledge-service";
import { knowledgeOperationHash } from "../../projects/knowledge-store";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { createProjectKnowledgeRoutes } from "./project-knowledge";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
const request = {
  requestId: "90000000-0000-4000-8000-000000000001",
  expectedRevision: 1,
  repositoryKey: "a".repeat(64),
};
test("knowledge actions mount behind the common token, strict validation and audit runner; receipt recovery never reruns generation", async () => {
  const effects: string[] = [];
  let h: TestHearth;
  const receipt = knowledgeReceiptSchema.parse({
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
    requestHash: knowledgeOperationHash(FIXTURE_PROJECT_ID, request),
    repositoryKey: request.repositoryKey,
    state: "candidate-saved",
    sourceCommit: "b".repeat(40),
    evidenceHash: "c".repeat(64),
    candidateHash: "d".repeat(64),
    confirmedAt: null,
    message: "Saved fixture candidate",
    retainedExtensions: [],
  });
  const service: ReturnType<typeof createKnowledgeService> = {
    status: (projectId) => ({
      projectId,
      catalogRevision: 1,
      repositoryKey: request.repositoryKey,
      name: "fixture",
      state: "missing",
      ageDays: null,
      freshness: "missing",
      asOf: new Date().toISOString(),
      archived: false,
    }),
    receipt: (projectId, requestId) => {
      if (projectId !== FIXTURE_PROJECT_ID || requestId !== request.requestId)
        throw new ConversationError(404, "Original absent");
      return receipt;
    },
    refresh: async () => {
      expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        action: "project.knowledge.refresh",
        inputHash: receipt.requestHash,
      });
      effects.push("refresh");
      return receipt;
    },
    publish: async () => {
      effects.push("publish");
      return receipt;
    },
    retire: async () => {
      effects.push("retire");
      return receipt;
    },
  };
  expect(createProjectKnowledgeRoutes(service).actions).toHaveLength(3);
  h = await startTestHearth({ api: { projectKnowledge: service } });
  opened.push(h);
  const base = `${h.api}/projects/${FIXTURE_PROJECT_ID}/settings/knowledge`,
    post = (path: string, body: unknown, token?: string) =>
      fetch(base + path, {
        method: "POST",
        headers: h.headers(token),
        body: JSON.stringify(body),
      });
  expect((await post("", request)).status).toBe(403);
  expect(effects).toEqual([]);
  expect(
    (await post("", { ...request, outputPath: "/foreign" }, h.hearth.token))
      .status,
  ).toBe(400);
  expect(effects).toEqual([]);
  expect((await post("", request, h.hearth.token)).status).toBe(200);
  expect(effects).toEqual(["refresh"]);
  expect((await fetch(base, { headers: h.headers() })).status).toBe(403);
  expect(
    (await fetch(base, { headers: h.headers(h.hearth.token) })).status,
  ).toBe(200);
  expect(
    (
      await fetch(base + "/" + request.requestId, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(200);
  expect(effects).toEqual(["refresh"]);
  expect(
    (
      await post(
        "/" + request.requestId + "/publish",
        { requestHash: "f".repeat(64) },
        h.hearth.token,
      )
    ).status,
  ).toBe(409);
  expect(effects).toEqual(["refresh"]);
  expect(
    (
      await post(
        "/" + request.requestId + "/publish",
        { requestHash: receipt.requestHash },
        h.hearth.token,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/" + request.requestId + "/retire",
        { requestHash: receipt.requestHash },
        h.hearth.token,
      )
    ).status,
  ).toBe(200);
  expect(effects).toEqual(["refresh", "publish", "retire"]);
});

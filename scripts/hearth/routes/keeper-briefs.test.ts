import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createConversationStore } from "../../conversations/store";
import { briefsSchema } from "../../keeper/brief-protocol";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

async function terminal(
  store: ReturnType<typeof createConversationStore>,
  phase: "completed" | "failed",
) {
  const deadline = Date.now() + 3000;
  while (store.read(FIXTURE_PROJECT_ID).turns.at(-1)?.phase !== phase) {
    if (Date.now() >= deadline)
      throw new Error(`Fixture turn did not reach ${phase}`);
    await Bun.sleep(5);
  }
  expect(store.read(FIXTURE_PROJECT_ID).turns.at(-1)?.phase).toBe(phase);
}

test("audited brief refresh shares the standing turn, protects private prose and preserves a good brief across failed/malformed refreshes", async () => {
  let starts = 0;
  let mode: "normal" | "failed" | "malformed" = "normal";
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run(request, sink) {
          starts++;
          expect(request.input.text).toContain("Snapshot:");
          await sink({
            kind: "identity",
            provider: "claude",
            sessionId: "actual-brief-fixture",
            version: "fixture",
          });
          await sink({
            kind: "text",
            text:
              mode === "malformed"
                ? "Not a structured brief"
                : JSON.stringify({
                    summary:
                      "No recorded movement in the available project read.",
                    moving: [],
                    waiting: [],
                    stuck: [],
                  }),
          });
          return {
            phase: mode === "failed" ? "failed" : "completed",
            reason: mode === "failed" ? "Fixture failure" : null,
          };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Alpha source evidence",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) + "\n",
          stderr: "",
        }
      : undefined;
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`;
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  const projection = async () => {
    const response = await fetch(path, { headers: h.headers(h.hearth.token) });
    expect(response.status).toBe(200);
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== "object" || !("data" in envelope))
      throw new Error("Missing brief projection");
    const parsed = briefsSchema.safeParse(envelope.data);
    if (!parsed.success) throw new Error("Invalid brief projection");
    return parsed.data;
  };
  expect((await projection()).latest).toBeNull();
  expect(starts).toBe(0);
  const input = { requestId: randomUUID(), expectedRevision: 0 };
  const post = (body: unknown) =>
    fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
    });
  expect((await post({ ...input, snapshot: { forged: true } })).status).toBe(
    400,
  );
  expect(starts).toBe(0);
  expect((await post(input)).status).toBe(202);
  const store = createConversationStore(h.home);
  await terminal(store, "completed");
  const original = (await projection()).latest;
  expect(original?.snapshot.observed.beads).toBe(1);
  expect(original?.snapshot.scope.label).toBe("project:alpha");
  expect((await post(input)).status).toBe(202);
  expect(starts).toBe(1);
  for (const next of ["failed", "malformed"] as const) {
    mode = next;
    expect(
      (
        await post({
          requestId: randomUUID(),
          expectedRevision: store.read(FIXTURE_PROJECT_ID).revision,
        })
      ).status,
    ).toBe(202);
    await terminal(store, next === "failed" ? "failed" : "completed");
    const after = await projection();
    expect(after.latest).toEqual(original);
    expect(after.refresh?.problem).toContain("previous brief has been kept");
  }
  expect(JSON.stringify(h.events())).not.toContain("Alpha source evidence");
  expect(JSON.stringify(h.events())).not.toContain("No recorded movement");
  expect(
    h
      .events(["operator.action"])
      .some(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "keeper.brief.refresh",
      ),
  ).toBe(true);
});

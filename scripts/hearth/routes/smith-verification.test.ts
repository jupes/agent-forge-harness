import { afterEach, expect, test } from "bun:test";
import { MAX_SMITH_VERIFICATION_BYTES } from "../../smith-verification";
import { startTestHearth, type TestHearth } from "../testing";

const verificationId = "agent-forge-harness-cla5.6.6.1";
const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("verification reads refuse arbitrary queries and unsupported methods before any tracker call", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const before = h.bd.calls.length;
  for (const query of [
    "?id=other",
    "?projectId=alpha",
    "?command=close",
    "?id=a&id=b",
  ]) {
    const response = await fetch(`${h.api}/smiths/verification${query}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(400);
  }
  const foreign = await fetch(`${h.api}/smiths/verification`, {
    headers: {
      ...h.headers(h.hearth.token),
      Origin: "https://example.invalid",
    },
  });
  expect(foreign.status).toBe(403);
  const write = await fetch(`${h.api}/smiths/verification`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
  });
  expect(write.ok).toBe(false);
  expect(h.bd.calls.length).toBe(before);
});

test("unavailable, unbounded or unverified tracker answers never become verification facts", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const valid = {
    id: verificationId,
    title: "Recorded task",
    status: "in_progress",
    priority: 2,
  };
  const answers = [
    "not JSON",
    "[]",
    "{}",
    JSON.stringify([valid, valid]),
    JSON.stringify([{ ...valid, id: "foreign-task" }]),
    JSON.stringify([{ ...valid, status: true }]),
    JSON.stringify([{ ...valid, priority: "0" }]),
    JSON.stringify([{ ...valid, priority: 5 }]),
    JSON.stringify([{ ...valid, description: null }]),
    JSON.stringify([{ ...valid, updated_at: "yesterday" }]),
    JSON.stringify([{ ...valid, title: "bad\u0000title" }]),
    JSON.stringify([
      {
        ...valid,
        notes: "🌱".repeat(Math.ceil(MAX_SMITH_VERIFICATION_BYTES / 4)),
      },
    ]),
  ];
  for (const stdout of answers) {
    h.bd.answer = (args) =>
      args.includes("show")
        ? { status: 0, stdout, stderr: "PRIVATE-STDERR" }
        : undefined;
    const response = await fetch(`${h.api}/smiths/verification`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      data: null,
      error: expect.stringContaining("could not be read and verified"),
    });
  }
  h.bd.answer = (args) =>
    args.includes("show")
      ? { status: 1, stdout: JSON.stringify([valid]), stderr: "PRIVATE-STDERR" }
      : undefined;
  const failed = await fetch(`${h.api}/smiths/verification`, {
    headers: h.headers(h.hearth.token),
  });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("PRIVATE-STDERR");
  expect(
    h.events().filter((event) => event.kind === "operator.action"),
  ).toEqual([]);
});

test("a never-settling injected tracker read has its own deadline and cannot publish a late answer", async () => {
  const h = await startTestHearth({ api: { bdTimeoutMs: 40 } });
  opened.push(h);
  let release:
    | ((answer: { status: number; stdout: string; stderr: string }) => void)
    | undefined;
  h.bd.answer = (args) =>
    args.includes("show")
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const response = await fetch(`${h.api}/smiths/verification`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(503);
  expect(h.bd.options.at(-1)).toEqual({ timeoutMs: 40 });
  release?.({
    status: 0,
    stdout: JSON.stringify([
      { id: verificationId, title: "Late task", status: "open" },
    ]),
    stderr: "",
  });
  const unavailable = await response.json();
  expect(unavailable.ok).toBe(false);
  h.bd.answer = (args) =>
    args.includes("show")
      ? {
          status: 0,
          stdout: JSON.stringify([
            {
              id: verificationId,
              title: "Fresh task",
              status: "closed",
              priority: null,
            },
          ]),
          stderr: "",
        }
      : undefined;
  const fresh = await fetch(`${h.api}/smiths/verification`, {
    headers: h.headers(h.hearth.token),
  });
  expect(fresh.status).toBe(200);
  expect((await fresh.json()).data.task).toEqual({
    id: verificationId,
    title: "Fresh task",
    status: "closed",
    priority: null,
    description: "",
    acceptanceCriteria: "",
    notes: "",
    updatedAt: null,
  });
});

test("Smiths opens only its fixed verification task from the protected served tracker without project membership or writes", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.answer = (args) =>
    args[0] === "--readonly" && args[1] === "show"
      ? {
          status: 0,
          stdout: JSON.stringify([
            {
              id: verificationId,
              title: "Owner verification remains pending",
              status: "open",
              priority: 0,
              description:
                "Visible tracker details <script>stay inert</script>",
              acceptance_criteria:
                "The owner records the actual native result.",
              notes: "No provider verification is inferred.",
              updated_at: "2026-10-23T00:00:00Z",
              unrelated_private_field: "NOT-PART-OF-THE-READ",
            },
          ]),
          stderr: "",
        }
      : undefined;
  const path = `${h.api}/smiths/verification`;
  const denied = await fetch(path, { headers: h.headers() });
  expect(denied.status).toBe(403);
  expect(h.bd.calls.filter((args) => args.includes("show"))).toEqual([]);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  expect(envelope.error).toBeNull();
  expect(envelope.data).toMatchObject({
    workspace: h.workspace,
    task: {
      id: verificationId,
      title: "Owner verification remains pending",
      status: "open",
      priority: 0,
      acceptanceCriteria: "The owner records the actual native result.",
      notes: "No provider verification is inferred.",
    },
  });
  expect(Number.isFinite(Date.parse(envelope.data.checkedAt))).toBe(true);
  expect(JSON.stringify(envelope)).not.toContain("NOT-PART-OF-THE-READ");
  expect(h.bd.calls.filter((args) => args.includes("show"))).toEqual([
    ["--readonly", "show", verificationId, "--json"],
  ]);
  expect(
    h.events().filter((event) => event.kind === "operator.action"),
  ).toEqual([]);
});

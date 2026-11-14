import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  projectCheckpointSubmissionOriginalSchema,
  projectCheckpointSubmissionScope,
} from "../../types/project-checkpoint-submissions";
import { tokenPath } from "../hearth/home";
import {
  checkpointSourceArtifactJson,
  connectCheckpointSource,
  parseCheckpointSourceArgs,
  runCheckpointSource,
} from "./checkpoint-source-cli";

const root = "C:/served/checkout";
const project = "project-12345678-1234-4234-8234-123456789abc";
const scope = [
  "--root",
  root,
  "--project",
  project,
  "--run",
  "demo",
  "--bead",
  "forge-demo.1",
];
test("the caller parses exact commands and refuses ambiguous flags before any connection", () => {
  expect(parseCheckpointSourceArgs(["context", ...scope]).command).toBe(
    "context",
  );
  for (const args of [
    ["context", ...scope, "--root", root],
    ["context", ...scope, "--url", "http://127.0.0.1:1"],
    ["context", ...scope, "junk"],
    ["apply", "--root", root, "--file", "saved.json"],
    ["context", ...scope.slice(0, -1), "<bead>"],
  ])
    expect(() => parseCheckpointSourceArgs(args)).toThrow();
});

const binding = {
  projectId: project,
  workspacePath: root,
  checkout: root,
  runSlug: "demo",
  beadId: "forge-demo.1",
  epicId: "forge-demo",
  runUpdatedAt: "2026-11-13T00:00:00.000Z",
  catalogRevision: 1,
  scopeHash: "a".repeat(64),
};
const sourceVersion = {
  kind: "committed-git-snapshot",
  commit: "b".repeat(40),
  tree: "c".repeat(40),
};
test("draft publication captures checked source and makes no POST", async () => {
  const calls: string[] = [];
  const result = await runCheckpointSource(
    [
      "draft-publish",
      ...scope,
      "--request-id",
      "12345678-1234-4234-8234-123456789abc",
    ],
    {
      connect: async () => async (request) => {
        calls.push(request.method);
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            data: {
              available: true,
              context: {
                state: "unbound",
                generation: 0,
                continuity: "legacy-unverified",
                baseBinding: binding,
                sourceVersion,
                reviewBinding: null,
                record: null,
                foreign: null,
              },
            },
            error: null,
          }),
        };
      },
      readFile: async () => {
        throw Error("No input read");
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(calls).toEqual(["GET"]);
  expect(JSON.stringify(result)).toContain(sourceVersion.commit);
});

test("the existing loopback transport owns Host while the caller supplies origin and credentials", async () => {
  const home = "/inert-home";
  const lock = {
    pid: 1,
    port: 4567,
    root,
    startedAt: "2026-11-13T00:00:00.000Z",
    tokenFile: tokenPath(home, root),
  };
  const send = await connectCheckpointSource(root, {
    home,
    canonicalRoot: (value) => value,
    readLock: () => ({ problem: null, lock }),
    alive: () => true,
    health: async () => null,
    readToken: (file) => {
      expect(file).toBe(tokenPath(home, root));
      return "a".repeat(64);
    },
    exchange: async (request) => {
      expect(
        Object.keys(request.headers).some(
          (key) => key.toLowerCase() === "host",
        ),
      ).toBe(false);
      expect(request.headers["Origin"]).toBe("http://127.0.0.1:4567");
      expect(request.headers["x-agent-forge-operator"]).toBe("a".repeat(64));
      expect(request.headers["x-agent-forge-surface"]).toBe("cli");
      return { status: 200, body: "{}" };
    },
  });
  await send({ method: "GET", target: "/projects" });
});

async function draftFixture() {
  const result = await runCheckpointSource(
    [
      "draft-publish",
      ...scope,
      "--request-id",
      "12345678-1234-4234-8234-123456789abc",
    ],
    {
      connect: async () => async () => ({
        status: 200,
        body: JSON.stringify({
          ok: true,
          data: {
            available: true,
            context: {
              state: "unbound",
              generation: 0,
              continuity: "legacy-unverified",
              baseBinding: binding,
              sourceVersion,
              reviewBinding: null,
              record: null,
              foreign: null,
            },
          },
          error: null,
        }),
      }),
    },
  );
  const data = z
    .object({
      original: projectCheckpointSubmissionOriginalSchema,
      originalHash: z.string(),
    })
    .parse(result.data);
  const reviewHash = createHash("sha256")
    .update(
      JSON.stringify({
        family: "checkpoint-source-submission",
        originalHash: data.originalHash,
        schemaVersion: 1,
      }),
    )
    .digest("hex");
  const record = {
    original: data.original,
    originalHash: data.originalHash,
    receipt: {
      schemaVersion: 1,
      requestId: data.original.requestId,
      originalHash: data.originalHash,
      scope: projectCheckpointSubmissionScope(data.original),
      state: "applied",
      observedGeneration: 0,
      resultingGeneration: 1,
      auditEventId: 1,
      appliedAt: "2026-11-13T00:00:00.000Z",
      reviewScopeHash: reviewHash,
    },
  };
  return {
    data,
    record,
    file: checkpointSourceArtifactJson(result),
    args: ["--root", root, "--file", "saved.json", "--hash", data.originalHash],
  };
}
test("apply sends one captured original and reports only its historical transaction", async () => {
  const f = await draftFixture(),
    calls: string[] = [];
  const answer = await runCheckpointSource(["apply", ...f.args], {
    readFile: async () => "\uFEFF" + f.file + "\r\n",
    connect: async () => async (request) => {
      calls.push(request.method);
      expect(request.body).toBe(checkpointSourceArtifactJson(f.data.original));
      return {
        status: 200,
        body: JSON.stringify({
          ok: true,
          data: { created: true, record: f.record },
          error: null,
        }),
      };
    },
  });
  expect(answer.ok).toBe(true);
  expect(answer.data).toEqual({
    state: "historically-applied",
    record: f.record,
  });
  expect(calls).toEqual(["POST"]);
});
test("lost, malformed or forged publication replies remain unknown without retry", async () => {
  const f = await draftFixture();
  for (const reply of [
    null,
    { status: 200, body: "invalid" },
    {
      status: 200,
      body: JSON.stringify({
        ok: true,
        data: {
          created: true,
          record: {
            ...f.record,
            receipt: { ...f.record.receipt, reviewScopeHash: "0".repeat(64) },
          },
        },
        error: null,
      }),
    },
  ]) {
    let calls = 0;
    const answer = await runCheckpointSource(["apply", ...f.args], {
      readFile: async () => f.file,
      connect: async () => async () => {
        calls++;
        if (!reply) throw Error("lost reply with private path");
        return reply;
      },
    });
    expect(answer.data).toMatchObject({
      state: "unknown",
      requestId: f.data.original.requestId,
      originalHash: f.data.originalHash,
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(answer)).not.toContain("private path");
  }
});
test("recover404 is unknown and exact historical recovery makes no POST", async () => {
  const f = await draftFixture();
  for (const found of [false, true]) {
    const calls: string[] = [];
    const answer = await runCheckpointSource(["recover", ...f.args], {
      readFile: async () => f.file,
      connect: async () => async (request) => {
        calls.push(request.method);
        return found
          ? {
              status: 200,
              body: JSON.stringify({ ok: true, data: f.record, error: null }),
            }
          : { status: 404, body: "{}" };
      },
    });
    expect(answer.data).toMatchObject({
      state: found ? "historically-applied" : "unknown",
    });
    expect(calls).toEqual(["GET"]);
  }
});
test("bad canonical artifacts and hashes refuse before connection", async () => {
  const f = await draftFixture();
  for (const file of [
    f.file + " ",
    f.file.replace('"ok":true', '"ok":true,"ok":true'),
    f.file.replace(f.data.originalHash, "0".repeat(64)),
    "x".repeat(128 * 1024 + 1),
  ]) {
    let connected = false;
    const answer = await runCheckpointSource(["apply", ...f.args], {
      readFile: async () => file,
      connect: async () => {
        connected = true;
        throw Error("Must not connect");
      },
    });
    expect(answer.ok).toBe(false);
    expect(connected).toBe(false);
  }
});
test("a lock changed after health refuses before token read or protected exchange", async () => {
  const home = "/inert-home",
    lock = {
      pid: 1,
      port: 4567,
      root,
      startedAt: "2026-11-13T00:00:00.000Z",
      tokenFile: tokenPath(home, root),
    };
  let changed = false,
    tokenReads = 0,
    requests = 0;
  await expect(
    connectCheckpointSource(root, {
      home,
      canonicalRoot: (value) => value,
      readLock: () => ({
        problem: null,
        lock: changed ? { ...lock, port: 4568 } : lock,
      }),
      alive: () => true,
      health: async () => {
        changed = true;
        return null;
      },
      readToken: () => {
        tokenReads++;
        return "a".repeat(64);
      },
      exchange: async () => {
        requests++;
        return { status: 200, body: "{}" };
      },
    }),
  ).rejects.toThrow();
  expect(tokenReads).toBe(0);
  expect(requests).toBe(0);
});

test("withdraw draft refuses a valid retained row returned for another UUID", async () => {
  const f = await draftFixture(),
    target = "22345678-1234-4234-8234-123456789abc";
  const answer = await runCheckpointSource(
    [
      "draft-withdraw",
      ...scope,
      "--request-id",
      "32345678-1234-4234-8234-123456789abc",
      "--target-request-id",
      target,
      "--target-hash",
      f.data.originalHash,
    ],
    {
      connect: async () => async (request) => ({
        status: 200,
        body: JSON.stringify({
          ok: true,
          data: request.target.endsWith("/source-submissions")
            ? {
                generation: 1,
                everBound: true,
                legacySource: null,
                blocked: false,
                currentRequestId: target,
                items: [f.record],
              }
            : f.record,
          error: null,
        }),
      }),
    },
  );
  expect(answer.ok).toBe(false);
});
test("context refuses an available reply naming another routed checkpoint", async () => {
  const answer = await runCheckpointSource(["context", ...scope], {
    connect: async () => async () => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        data: {
          available: true,
          context: {
            state: "unbound",
            generation: 0,
            continuity: "legacy-unverified",
            baseBinding: { ...binding, beadId: "forge-demo.2" },
            sourceVersion,
            reviewBinding: null,
            record: null,
            foreign: null,
          },
        },
        error: null,
      }),
    }),
  });
  expect(answer.ok).toBe(false);
});

test("a Withdraw draft names the explicit verified current source and generation without POST", async () => {
  const f = await draftFixture(),
    calls: string[] = [];
  const answer = await runCheckpointSource(
    [
      "draft-withdraw",
      ...scope,
      "--request-id",
      "32345678-1234-4234-8234-123456789abc",
      "--target-request-id",
      f.data.original.requestId,
      "--target-hash",
      f.data.originalHash,
    ],
    {
      connect: async () => async (request) => {
        calls.push(request.method);
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            data: request.target.endsWith("/source-submissions")
              ? {
                  generation: 1,
                  everBound: true,
                  legacySource: null,
                  blocked: false,
                  currentRequestId: f.data.original.requestId,
                  items: [f.record],
                }
              : f.record,
            error: null,
          }),
        };
      },
    },
  );
  expect(answer.ok).toBe(true);
  expect(answer.data).toMatchObject({
    original: {
      kind: "withdraw",
      scope: projectCheckpointSubmissionScope(f.data.original),
      targetSubmissionRequestId: f.data.original.requestId,
      targetOriginalHash: f.data.originalHash,
      expectedSubmissionGeneration: 1,
    },
  });
  expect(calls).toEqual(["GET", "GET"]);
});
test("unsupported token bytes refuse before the protected exchange", async () => {
  for (const token of [
    null,
    "a".repeat(63),
    "A".repeat(64),
    " a".repeat(32),
    "g".repeat(64),
  ]) {
    const home = "/inert-home",
      lock = {
        pid: 1,
        port: 4567,
        root,
        startedAt: "2026-11-13T00:00:00.000Z",
        tokenFile: tokenPath(home, root),
      };
    let requests = 0;
    const send = await connectCheckpointSource(root, {
      home,
      canonicalRoot: (value) => value,
      readLock: () => ({ problem: null, lock }),
      alive: () => true,
      health: async () => null,
      readToken: () => token,
      exchange: async () => {
        requests++;
        return { status: 200, body: "{}" };
      },
    });
    await expect(
      send({ method: "GET", target: "/projects" }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  }
});

test("untrusted, wrong-root, dead-PID and foreign-token locks refuse before credentials", async () => {
  for (const variant of ["untrusted", "wrong-root", "dead-pid", "token-path"]) {
    const home = "/inert-home",
      lock = {
        pid: 1,
        port: 4567,
        root: variant === "wrong-root" ? root + "/other" : root,
        startedAt: "2026-11-13T00:00:00.000Z",
        tokenFile:
          tokenPath(home, root) + (variant === "token-path" ? ".other" : ""),
      };
    let tokens = 0,
      requests = 0,
      health = 0;
    await expect(
      connectCheckpointSource(root, {
        home,
        canonicalRoot: (value) => value,
        readLock: () => {
          if (variant === "untrusted")
            return { problem: "untrusted", lock: null };
          return { problem: null, lock };
        },
        alive: () => variant !== "dead-pid",
        health: async () => {
          health++;
          return null;
        },
        readToken: () => {
          tokens++;
          return "a".repeat(64);
        },
        exchange: async () => {
          requests++;
          return { status: 200, body: "{}" };
        },
      }),
    ).rejects.toThrow();
    expect(tokens).toBe(0);
    expect(requests).toBe(0);
    expect(health).toBe(0);
  }
});
test("lock replacement after connection refuses POST before reading a token", async () => {
  const home = "/inert-home",
    lock = {
      pid: 1,
      port: 4567,
      root,
      startedAt: "2026-11-13T00:00:00.000Z",
      tokenFile: tokenPath(home, root),
    };
  let changed = false,
    tokens = 0,
    requests = 0;
  const send = await connectCheckpointSource(root, {
    home,
    canonicalRoot: (value) => value,
    readLock: () => ({
      problem: null,
      lock: changed ? { ...lock, pid: 2 } : lock,
    }),
    alive: () => true,
    health: async () => null,
    readToken: (file) => {
      expect(file).toBe(tokenPath(home, root));
      tokens++;
      return "a".repeat(64);
    },
    exchange: async () => {
      requests++;
      return { status: 200, body: "{}" };
    },
  });
  changed = true;
  await expect(
    send({ method: "POST", target: "/projects", body: "{}" }),
  ).rejects.toThrow();
  expect(tokens).toBe(0);
  expect(requests).toBe(0);
});

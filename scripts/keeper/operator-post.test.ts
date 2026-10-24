import { expect, test } from "bun:test";
import { createKeeperOperatorPost } from "./operator-post";

test("approved business calls use one fixed loopback target and server token; no model path, flag or proxy destination is accepted", async () => {
  const seen: unknown[] = [];
  const post = createKeeperOperatorPost({
    origin: () => "http://127.0.0.1:12345",
    operatorToken: () => "fixture-operator-capability",
    exchange: async (request) => {
      seen.push(request);
      return { status: 200, body: '{"ok":true,"data":{},"error":null}' };
    },
  });
  await post({ kind: "queue.move", id: "alpha-1", action: "approve" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    port: 12345,
    method: "POST",
    target: "/__agent-forge/queue/alpha-1/approve",
    body: "{}",
    headers: {
      Origin: "http://127.0.0.1:12345",
      "x-agent-forge-operator": "fixture-operator-capability",
    },
  });
  for (const value of [
    { kind: "http", path: "/beads" },
    { kind: "queue.move", id: "alpha-1", action: "approve", path: "/shifts" },
    { kind: "queue.move", id: "--help", action: "approve" },
    {
      kind: "bead.comment",
      id: "alpha-1",
      text: "Review",
      token: "chosen-by-input",
    },
  ])
    await expect(post(value)).rejects.toThrow("operator call");
  expect(seen).toHaveLength(1);
  const absent = createKeeperOperatorPost({
    origin: () => "http://127.0.0.1:12345",
    operatorToken: () => null,
    exchange: async () => {
      throw new Error("Must not send");
    },
  });
  await expect(
    absent({ kind: "queue.move", id: "alpha-1", action: "approve" }),
  ).rejects.toThrow("operator token");
});

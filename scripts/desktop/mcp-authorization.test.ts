import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createIntegrationAuthorization } from "./mcp-authorization";

const requestId = "ad000000-0000-4000-8000-000000000001";
function fixture() {
  const writes: {
    home: string;
    folder: string;
    file: string;
    bytes: string;
  }[] = [];
  const root = resolve("fixture-checkout"),
    home = resolve("fixture-private-home");
  const authorize = createIntegrationAuthorization({
    root,
    home,
    now: () => 1000,
    publish: (record) => {
      writes.push(record);
    },
  });
  return { authorize, writes, root, home };
}
test("only a confirmed audit row permits a scope-bound metadata ticket", () => {
  const box = fixture();
  const result = box.authorize({ client: "claude", requestId }, 42);
  expect(result).toEqual({
    schemaVersion: 1,
    client: "claude",
    requestId,
    authorized: true,
  });
  expect(box.writes).toHaveLength(1);
  const write = box.writes[0];
  if (!write) throw Error("missing ticket");
  expect(write.file).toBe(
    resolve(box.home, "mcp-authorizations", "claude.json"),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(write.bytes);
  } catch {
    throw Error("Invalid ticket JSON");
  }
  expect(parsed).toEqual({
    schemaVersion: 1,
    client: "claude",
    requestId,
    root: box.root,
    home: box.home,
    auditEventId: 42,
    createdAt: 1000,
  });
});
test("missing or malformed audit authority is refused before a private ticket write", () => {
  for (const audit of [
    undefined,
    0,
    -1,
    NaN,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const box = fixture();
    expect(() =>
      box.authorize({ client: "codex", requestId }, audit),
    ).toThrow();
    expect(box.writes).toHaveLength(0);
  }
});
test("renderer paths, commands, environment, arbitrary clients and malformed ids are refused", () => {
  for (const body of [
    { client: "other", requestId },
    { client: "cursor", requestId: "../foreign" },
    { client: "cursor", requestId, file: "C:/foreign" },
    { client: "cursor", requestId, command: "PRIVATE_CONFIG" },
    { client: "cursor", requestId, env: { TOKEN: "PRIVATE_CONFIG" } },
  ]) {
    const box = fixture();
    expect(() => box.authorize(body, 42)).toThrow();
    expect(box.writes).toHaveLength(0);
  }
});
test("all three clients use their fixed private authorization filename", () => {
  for (const client of ["claude", "codex", "cursor"]) {
    const box = fixture();
    box.authorize({ client, requestId }, 42);
    expect(box.writes[0]?.file).toBe(
      resolve(box.home, "mcp-authorizations", client + ".json"),
    );
  }
});
test("private publication failure is redacted and never changes a client config", () => {
  const authorize = createIntegrationAuthorization({
    root: resolve("fixture-checkout"),
    home: resolve("fixture-home"),
    publish() {
      throw Error("PRIVATE_CONFIG");
    },
  });
  expect(() => authorize({ client: "claude", requestId }, 42)).toThrow(
    "authorization-unavailable",
  );
  try {
    authorize({ client: "claude", requestId }, 42);
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE_CONFIG");
  }
});

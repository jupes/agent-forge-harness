import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  createNativeUpdateAuthorization,
  type UpdateTicket,
} from "./native-update-authorization";

const requestId = "ad000000-0000-4000-8000-000000000001";
test("only confirmed audit authority can publish a closed operation and exact scope-bound private update ticket", () => {
  const writes: UpdateTicket[] = [],
    root = resolve("fixture-root"),
    home = resolve("fixture-home");
  const authorize = createNativeUpdateAuthorization({
    root,
    home,
    now: () => 1000,
    publish: (ticket) => {
      writes.push(ticket);
    },
  });
  const request = { operation: "install" as const, requestId };
  expect(authorize(request, 42)).toEqual({
    ...request,
    schemaVersion: 1,
    authorized: true,
  });
  expect(writes).toHaveLength(1);
  const ticket = writes[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ticket.bytes);
  } catch {
    throw Error("Invalid ticket JSON");
  }
  expect(parsed).toEqual({
    ...request,
    schemaVersion: 1,
    root,
    home,
    auditEventId: 42,
    createdAt: 1000,
  });
  expect(ticket.file).toBe(join(home, "update-authorizations", "install.json"));
  expect(
    JSON.stringify(authorize({ operation: "check", requestId }, 43)),
  ).not.toContain(home);
});
test("missing audit, invalid operation and arbitrary selectors never publish authorization", () => {
  const writes: UpdateTicket[] = [],
    authorize = createNativeUpdateAuthorization({
      root: resolve("fixture-root"),
      home: resolve("fixture-home"),
      publish: (t) => {
        writes.push(t);
      },
    });
  for (const audit of [undefined, 0, -1, NaN, 1.5])
    expect(() => authorize({ operation: "check", requestId }, audit)).toThrow();
  for (const raw of [
    { operation: "erase", requestId },
    { operation: "install", requestId, url: "https://foreign" },
    { operation: "install", requestId: "../foreign" },
  ])
    expect(() => authorize(raw, 42)).toThrow();
  expect(writes).toEqual([]);
});
test("private update ticket publication errors never expose raw home or error data", () => {
  const authorize = createNativeUpdateAuthorization({
    root: resolve("fixture-root"),
    home: resolve("fixture-home"),
    publish() {
      throw Error("PRIVATE_ERROR_WITH_TOKEN");
    },
  });
  expect(() => authorize({ operation: "download", requestId }, 42)).toThrow(
    "authorization-unavailable",
  );
});

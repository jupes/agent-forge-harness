import { describe, expect, test } from "bun:test";
import {
  retireSessionStartIdentitySchema,
  sessionStartIdentityPageSchema,
  sessionStartIdentityReplySchema,
} from "./identity-protocol";

const scope = {
  family: "owned-session-start" as const,
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "c:/workspace",
};
const identity = {
  version: 1 as const,
  requestId: "18da5c95-3218-439c-a33d-e5662465f505",
  requestHash: "a".repeat(64),
  provider: "claude" as const,
  mode: "chat" as const,
  state: "reserved" as const,
};

describe("Session Start identity wire protocol", () => {
  test("accepts compact page and reply DTOs", () => {
    expect(
      sessionStartIdentityPageSchema.parse({
        version: 1,
        scope,
        identities: [identity],
      }),
    ).toEqual({
      version: 1,
      scope,
      identities: [identity],
    });
    expect(
      sessionStartIdentityReplySchema.parse({ version: 1, scope, identity }),
    ).toEqual({
      version: 1,
      scope,
      identity,
    });
    expect(
      retireSessionStartIdentitySchema.parse({ requestHash: "a".repeat(64) }),
    ).toEqual({
      requestHash: "a".repeat(64),
    });
  });

  test("projects not-sent truth without exposing the private attempt generation", () => {
    const notSent = { ...identity, state: "not-sent" as const };
    expect(
      sessionStartIdentityPageSchema.parse({
        version: 1,
        scope,
        identities: [notSent],
      }),
    ).toEqual({ version: 1, scope, identities: [notSent] });
    expect(
      sessionStartIdentityPageSchema.safeParse({
        version: 1,
        scope,
        identities: [{ ...notSent, attemptGeneration: 2 }],
      }).success,
    ).toBe(false);
  });

  test("rejects private fields, noncanonical scopes, duplicate UUIDs and unsupported versions", () => {
    expect(
      sessionStartIdentityPageSchema.safeParse({
        version: 1,
        scope,
        identities: [{ ...identity, prompt: "private" }],
      }).success,
    ).toBe(false);
    expect(
      sessionStartIdentityPageSchema.safeParse({
        version: 2,
        scope,
        identities: [],
      }).success,
    ).toBe(false);
    expect(
      sessionStartIdentityPageSchema.safeParse({
        version: 1,
        scope: { ...scope, workspace: "c:/workspace/" },
        identities: [],
      }).success,
    ).toBe(false);
    expect(
      sessionStartIdentityPageSchema.safeParse({
        version: 1,
        scope,
        identities: [identity, identity],
      }).success,
    ).toBe(false);
    expect(
      retireSessionStartIdentitySchema.safeParse({
        requestHash: "a".repeat(64),
        notSent: true,
      }).success,
    ).toBe(false);
  });
});

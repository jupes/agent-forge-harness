import { expect } from "bun:test";
import { createHash } from "node:crypto";
import type { RestartIdentityRow } from "../identities/restart-index";
import { createRestartIdentityJournal } from "../identities/restart-index";
import { workspaceKey } from "../projects/scope";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";

export async function expectStartIdentityState(
  home: string,
  projectId: string,
  workspace: string,
  raw: unknown,
  state: RestartIdentityRow["state"],
): Promise<void> {
  const request = parseOwnedSessionStart(raw);
  const expected = {
    version: 1 as const,
    address: { family: "owned-session-start" as const, projectId },
    workspace: workspaceKey(workspace),
    requestId: request.requestId,
    requestHash: createHash("sha256")
      .update(canonicalOwnedSessionStart(request))
      .digest("hex"),
    provider: "provider" in request ? request.provider : ("claude" as const),
    mode: request.launch.mode,
    state,
  };
  const actual = await createRestartIdentityJournal(home).lookup(
    { address: expected.address, workspace: expected.workspace },
    request.requestId,
  );
  expect(actual).toEqual(expected);
}

import { z } from "zod";
import type { OperatorPost, OperatorRead } from "../../../docs/js/operator";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "../../../scripts/sessions/codex-owned-protocol";
import {
  sessionStartIdentityPageSchema,
  sessionStartIdentityReplySchema,
} from "../../../scripts/sessions/identity-protocol";
import type { OwnedSessionStartRequest } from "../../../types/codex-owned-task";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
  SessionStartIdentityReply,
} from "../../../types/session-start-identities";

export interface VerifiedSessionIdentityScope {
  readonly projectId: string;
  readonly workspace: string;
  readonly generation: number;
}

export interface ReservedIdentityTuple
  extends Pick<
    SessionStartIdentityMetadata,
    "requestId" | "requestHash" | "provider" | "mode" | "state"
  > {}

export interface SessionStartIdentityServer {
  list(
    scope: VerifiedSessionIdentityScope,
    signal?: AbortSignal,
  ): Promise<SessionStartIdentityPage>;
  reserve(
    scope: VerifiedSessionIdentityScope,
    original: OwnedSessionStartRequest,
  ): Promise<{
    scope: SessionStartIdentityReply["scope"];
    identity: SessionStartIdentityMetadata;
    request: OwnedSessionStartRequest;
    requestHash: string;
  }>;
  retire(
    scope: VerifiedSessionIdentityScope,
    reserved: ReservedIdentityTuple,
  ): Promise<SessionStartIdentityReply>;
}

export interface SessionStartIdentityServerDependencies {
  currentScope(): VerifiedSessionIdentityScope | null;
  read: OperatorRead;
  post: OperatorPost;
}

const MAX_LIST_BYTES = 256 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const successEnvelopeSchema = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
type ScopeSnapshot = Readonly<{
  projectId: string;
  workspace: string;
  generation: number;
}>;
type CachedIdentity = Readonly<{
  scope: ScopeSnapshot;
  epoch: number;
  tuple: ReservedIdentityTuple;
}>;

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function snapshotScope(scope: VerifiedSessionIdentityScope): ScopeSnapshot {
  if (
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 0 ||
    scope.projectId.length > 80 ||
    scope.workspace.length > 1_024
  )
    throw Error("The verified Session Start scope is unavailable.");
  const workspace = workspaceKey(scope.workspace);
  const checked = sessionStartIdentityPageSchema.shape.scope.safeParse({
    family: "owned-session-start",
    projectId: scope.projectId,
    workspace,
  });
  if (!checked.success)
    throw Error("The verified Session Start scope is unavailable.");
  return Object.freeze({
    projectId: checked.data.projectId,
    workspace: checked.data.workspace,
    generation: scope.generation,
  });
}

function sameScope(a: ScopeSnapshot, b: ScopeSnapshot): boolean {
  return (
    a.projectId === b.projectId &&
    a.generation === b.generation &&
    workspaceKey(a.workspace) === workspaceKey(b.workspace)
  );
}

function apiPath(projectId: string): string {
  return `/__agent-forge/projects/${encodeURIComponent(projectId)}/session-start-identities`;
}

function scopeKey(scope: ScopeSnapshot): string {
  return JSON.stringify([scope.projectId, scope.workspace, scope.generation]);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw Error("The Session Start identity read was cancelled.");
}

function assertCurrentScope(
  deps: SessionStartIdentityServerDependencies,
  expected: ScopeSnapshot,
): void {
  const value = deps.currentScope();
  if (!value) throw Error("The verified Session Start scope changed.");
  let actual: ScopeSnapshot;
  try {
    actual = snapshotScope(value);
  } catch {
    throw Error("The verified Session Start scope changed.");
  }
  if (!sameScope(expected, actual))
    throw Error("The verified Session Start scope changed.");
}

function freezeIdentity(
  identity: SessionStartIdentityMetadata,
  scope: ScopeSnapshot,
  epoch: number,
  cache: WeakMap<object, CachedIdentity>,
): SessionStartIdentityMetadata {
  const copy = freezeDeep(structuredClone(identity));
  cache.set(copy, {
    scope,
    epoch,
    tuple: Object.freeze({
      requestId: copy.requestId,
      requestHash: copy.requestHash,
      provider: copy.provider,
      mode: copy.mode,
      state: copy.state,
    }),
  });
  return copy;
}

async function parseSuccessResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.ok)
    throw Error("The Session Start identity could not be verified.");
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw Error("The Session Start identity could not be verified.");
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw Error("The Session Start identity reply exceeds its limit.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error("The Session Start identity reply could not be verified.");
  }
  const envelope = successEnvelopeSchema.safeParse(raw);
  if (!envelope.success)
    throw Error("The Session Start identity reply could not be verified.");
  return envelope.data.data;
}

function identityTupleEqual(
  a: ReservedIdentityTuple,
  b: ReservedIdentityTuple,
): boolean {
  return (
    a.requestId === b.requestId &&
    a.requestHash === b.requestHash &&
    a.provider === b.provider &&
    a.mode === b.mode &&
    a.state === b.state
  );
}

function requestIdentity(request: OwnedSessionStartRequest): {
  requestId: string;
  provider: SessionStartIdentityMetadata["provider"];
  mode: SessionStartIdentityMetadata["mode"];
} {
  return {
    requestId: request.requestId,
    provider: "provider" in request ? request.provider : "claude",
    mode: request.launch.mode === "task" ? "task" : "chat",
  };
}

/** Browser-only protected transport for server-owned Session Start metadata. */
export function createSessionStartIdentityServer(
  dependencies: SessionStartIdentityServerDependencies,
): SessionStartIdentityServer {
  const verifiedRows = new WeakMap<object, CachedIdentity>();
  let activeScopeKey: string | null = null;
  let operationEpoch = 0;
  const nextEpoch = (key: string): number => {
    activeScopeKey = key;
    return ++operationEpoch;
  };
  const assertCurrentOperation = (
    expected: ScopeSnapshot,
    key: string,
    epoch: number,
    signal?: AbortSignal,
  ): void => {
    assertCurrentScope(dependencies, expected);
    assertNotAborted(signal);
    if (activeScopeKey !== key || operationEpoch !== epoch)
      throw Error(
        "A newer Session Start identity operation superseded this result.",
      );
  };
  return {
    async list(scope, signal) {
      const expected = snapshotScope(structuredClone(scope));
      assertCurrentScope(dependencies, expected);
      assertNotAborted(signal);
      const key = scopeKey(expected),
        epoch = nextEpoch(key);
      const response = await dependencies.read(
        apiPath(expected.projectId),
        { method: "GET", ...(signal ? { signal } : {}) },
        { maxBodyBytes: MAX_LIST_BYTES },
      );
      assertCurrentOperation(expected, key, epoch, signal);
      const raw = await parseSuccessResponse(response, MAX_LIST_BYTES);
      assertCurrentOperation(expected, key, epoch, signal);
      const parsed = sessionStartIdentityPageSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.scope.projectId !== expected.projectId ||
        workspaceKey(parsed.data.scope.workspace) !==
          workspaceKey(expected.workspace) ||
        parsed.data.identities.filter((row) =>
          ["reserved", "attempted", "not-sent"].includes(row.state),
        ).length > 1
      )
        throw Error("The Session Start identity page could not be verified.");
      const copy = structuredClone(parsed.data);
      copy.identities = copy.identities.map((row) =>
        freezeIdentity(row, expected, epoch, verifiedRows),
      );
      return freezeDeep(copy);
    },
    async reserve(scope, original) {
      const expected = snapshotScope(structuredClone(scope));
      assertCurrentScope(dependencies, expected);
      let request: OwnedSessionStartRequest;
      let canonical: string;
      try {
        request = freezeDeep(
          structuredClone(parseOwnedSessionStart(structuredClone(original))),
        );
        canonical = canonicalOwnedSessionStart(request);
      } catch {
        throw Error(
          "The original Session Start request could not be verified.",
        );
      }
      if (!requestIdentity(request).requestId)
        throw Error(
          "The original Session Start request could not be verified.",
        );
      const key = scopeKey(expected),
        epoch = nextEpoch(key);
      assertCurrentScope(dependencies, expected);
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(canonical),
          ),
        ),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      assertCurrentOperation(expected, key, epoch);
      const response = await dependencies.post(
        apiPath(expected.projectId),
        request,
        { maxBodyBytes: MAX_REPLY_BYTES },
      );
      assertCurrentOperation(expected, key, epoch);
      const raw = await parseSuccessResponse(response, MAX_REPLY_BYTES);
      assertCurrentOperation(expected, key, epoch);
      const parsed = sessionStartIdentityReplySchema.safeParse(raw);
      const wanted = requestIdentity(request);
      if (
        !parsed.success ||
        parsed.data.scope.projectId !== expected.projectId ||
        workspaceKey(parsed.data.scope.workspace) !==
          workspaceKey(expected.workspace) ||
        parsed.data.identity.requestId !== wanted.requestId ||
        parsed.data.identity.requestHash !== hash ||
        parsed.data.identity.provider !== wanted.provider ||
        parsed.data.identity.mode !== wanted.mode
      )
        throw Error("The Session Start identity reply could not be verified.");
      const resultEpoch = nextEpoch(key);
      const identity = freezeIdentity(
        parsed.data.identity,
        expected,
        resultEpoch,
        verifiedRows,
      );
      return freezeDeep({
        scope: structuredClone(parsed.data.scope),
        identity,
        request: structuredClone(request),
        requestHash: hash,
      });
    },
    async retire(scope, reserved) {
      const expected = snapshotScope(structuredClone(scope));
      assertCurrentScope(dependencies, expected);
      const snapshot = structuredClone(reserved);
      const trusted = verifiedRows.get(reserved);
      if (
        !trusted ||
        !sameScope(trusted.scope, expected) ||
        trusted.epoch !==
          (activeScopeKey === scopeKey(expected) ? operationEpoch : null) ||
        trusted.tuple.state !== "reserved" ||
        snapshot.state !== "reserved" ||
        !identityTupleEqual(snapshot, trusted.tuple)
      )
        throw Error("Only a verified reserved identity can be retired.");
      const key = scopeKey(expected),
        epoch = nextEpoch(key);
      assertCurrentScope(dependencies, expected);
      const response = await dependencies.post(
        `${apiPath(expected.projectId)}/${encodeURIComponent(snapshot.requestId)}/retire`,
        { requestHash: snapshot.requestHash },
        { maxBodyBytes: MAX_REPLY_BYTES },
      );
      assertCurrentOperation(expected, key, epoch);
      const raw = await parseSuccessResponse(response, MAX_REPLY_BYTES);
      assertCurrentOperation(expected, key, epoch);
      const parsed = sessionStartIdentityReplySchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.scope.projectId !== expected.projectId ||
        workspaceKey(parsed.data.scope.workspace) !==
          workspaceKey(expected.workspace) ||
        parsed.data.identity.requestId !== snapshot.requestId ||
        parsed.data.identity.requestHash !== snapshot.requestHash ||
        parsed.data.identity.provider !== snapshot.provider ||
        parsed.data.identity.mode !== snapshot.mode ||
        parsed.data.identity.state !== "retired"
      )
        throw Error(
          "The Session Start retirement reply could not be verified.",
        );
      verifiedRows.delete(reserved);
      nextEpoch(key);
      return freezeDeep({
        version: parsed.data.version,
        scope: structuredClone(parsed.data.scope),
        identity: structuredClone(parsed.data.identity),
      });
    },
  };
}

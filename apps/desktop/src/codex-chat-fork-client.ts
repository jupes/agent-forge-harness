/** Browser-only client for explicit Fork review and server-owned originals. */
import { z } from "zod";
import {
  NotSent,
  type OperatorPost,
  type OperatorRead,
} from "../../../docs/js/operator";
import { workspaceKey } from "../../../scripts/projects/scope";
import { CODEX_CHAT_FORK_PROTOCOL_VERSION } from "../../../scripts/sessions/codex-chat-fork-origin-protocol";
import {
  CODEX_CHAT_FORK_REVIEW_LIMITS,
  type CodexChatForkContextPage,
  type CodexChatForkSourcePage,
  codexChatForkCompleteSourceSchema,
  codexChatForkContextPageSchema,
  codexChatForkSourcePageSchema,
} from "../../../scripts/sessions/codex-chat-fork-review-protocol";
import { codexChatApprovalPageSchema } from "../../../scripts/sessions/codex-chat-owned-protocol";
import { ownedCodingPageSchema } from "../../../scripts/sessions/codex-owned-journal";
import {
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "../../../scripts/sessions/identity-protocol";
import {
  codexChatForkIdentityMetadataSchema,
  sessionOperationIdentityPageSchema,
} from "../../../scripts/sessions/session-operation-identities-protocol";
import type {
  CodexChatApprovalPage,
  CodexChatDecisionRequest,
} from "../../../types/codex-owned-chat";
import type { ConversationPage } from "../../../types/conversation";
import type { CodexChatForkIdentityMetadata } from "../../../types/session-operation-identities";
import type { SessionMessage } from "../../../types/session-turn";

const successEnvelopeSchema = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const intentSchema = z
  .object({
    requestId: sessionRequestIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
  })
  .strict();
const scopeSchema = z
  .object({
    projectId: z.string().min(1).max(80),
    workspace: z.string().min(1).max(1_024),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const RESPONSE_LIMIT = CODEX_CHAT_FORK_REVIEW_LIMITS.responseBytes;
const PAGE_LIMIT = CODEX_CHAT_FORK_REVIEW_LIMITS.pageItems;
const PAGE_COUNT_LIMIT = CODEX_CHAT_FORK_REVIEW_LIMITS.pages;
const OPERATOR_API_PREFIX = "/__agent-forge";
const FORK_HASH_DOMAIN = "agent-forge.codex-chat-fork.original.v1";

export interface ForkClientScope {
  readonly projectId: string;
  readonly workspace: string;
  readonly generation: number;
}

export interface ForkRecovery {
  state: "verified" | "held";
  identity: CodexChatForkIdentityMetadata | null;
  original: CodexChatForkIdentityMetadata | null;
  context: CodexChatForkContextPage | null;
}

interface ReviewProof {
  scope: ForkClientScope;
  source: CodexChatForkSourcePage;
}

interface ReservedFork {
  scope: ForkClientScope;
  parentSessionId: string;
  intent: z.infer<typeof intentSchema>;
  identity: CodexChatForkIdentityMetadata;
  dispatched: boolean;
  confirmed: boolean;
  notSent: boolean;
}

export interface CodexChatForkClient {
  reviewSource(
    input: {
      projectId: string;
      parentSessionId: string;
      throughTurnRequestId: string;
    },
    signal?: AbortSignal,
  ): Promise<CodexChatForkSourcePage>;
  reserveFork(input: {
    projectId: string;
    parentSessionId: string;
    throughTurnRequestId: string;
    source: CodexChatForkSourcePage;
  }): Promise<CodexChatForkIdentityMetadata>;
  dispatchReservedFork(
    projectId: string,
    requestId: string,
  ): Promise<{ state: "linked" | "held" | "retired" }>;
  canDispatchReservedFork(requestId: string): boolean;
  canRetireFork(requestId: string): boolean;
  recoverOriginal(projectId: string, requestId: string): Promise<ForkRecovery>;
  listOriginals(projectId: string): Promise<CodexChatForkIdentityMetadata[]>;
  readContext(
    projectId: string,
    requestId: string,
    after?: number,
    signal?: AbortSignal,
  ): Promise<CodexChatForkContextPage>;
  readChildTurns(
    projectId: string,
    childSessionId: string,
    requestId: string,
    after?: number,
    signal?: AbortSignal,
  ): Promise<ConversationPage>;
  readChildApprovals(
    projectId: string,
    childSessionId: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<CodexChatApprovalPage>;
  sendChildTurn(
    projectId: string,
    childSessionId: string,
    body: SessionMessage,
  ): Promise<unknown>;
  decideChildApproval(
    projectId: string,
    childSessionId: string,
    body: CodexChatDecisionRequest,
  ): Promise<unknown>;
  stopChild(
    projectId: string,
    childSessionId: string,
    requestId: string,
  ): Promise<unknown>;
  retireFork(
    projectId: string,
    requestId: string,
  ): Promise<CodexChatForkIdentityMetadata>;
  dispose(): void;
}

export interface CodexChatForkClientDependencies {
  currentScope(): ForkClientScope | null;
  canWrite(): boolean;
  requestId(): string;
  read: OperatorRead;
  post: OperatorPost;
}

function snapshotScope(raw: ForkClientScope | null): ForkClientScope {
  const parsed = scopeSchema.safeParse(raw);
  if (
    !parsed.success ||
    workspaceKey(parsed.data.workspace) !== parsed.data.workspace
  )
    throw new Error("The verified Fork workspace is unavailable.");
  return Object.freeze({ ...parsed.data });
}

function sameScope(left: ForkClientScope, right: ForkClientScope): boolean {
  return (
    left.projectId === right.projectId &&
    left.workspace === right.workspace &&
    left.generation === right.generation
  );
}

function assertScope(
  dependencies: CodexChatForkClientDependencies,
  expected: ForkClientScope,
  signal?: AbortSignal,
  disposed = false,
): void {
  if (disposed || signal?.aborted)
    throw new Error("The Fork operation was cancelled.");
  let actual: ForkClientScope;
  try {
    actual = snapshotScope(dependencies.currentScope());
  } catch {
    throw new Error("The verified Fork workspace changed.");
  }
  if (!sameScope(expected, actual))
    throw new Error("The verified Fork workspace changed.");
}

async function responseData(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown | null> {
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The Fork request could not be verified.");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error("The Fork response could not be read.");
  }
  if (
    signal?.aborted ||
    new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT
  )
    throw new Error(
      "The Fork response could not be verified within its limit.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The Fork response could not be verified.");
  }
  const envelope = successEnvelopeSchema.safeParse(raw);
  if (!envelope.success)
    throw new Error("The Fork response could not be verified.");
  return envelope.data.data;
}

function sameSource(
  left: CodexChatForkSourcePage,
  right: CodexChatForkSourcePage,
) {
  return (
    left.projectId === right.projectId &&
    left.parentSessionId === right.parentSessionId &&
    left.requestId === right.requestId &&
    left.throughTurnRequestId === right.throughTurnRequestId &&
    left.selectedTurnHash === right.selectedTurnHash &&
    JSON.stringify(left.target) === JSON.stringify(right.target) &&
    JSON.stringify(left.settings) === JSON.stringify(right.settings) &&
    JSON.stringify(left.provenance) === JSON.stringify(right.provenance)
  );
}

async function originalRequestHash(input: {
  projectId: string;
  workspace: string;
  parentSessionId: string;
  throughTurnRequestId: string;
  requestId: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    kind: "codex-chat-fork",
    hashVersion: 1,
    projectId: input.projectId,
    workspaceKey: input.workspace,
    parentSessionId: input.parentSessionId,
    throughTurnRequestId: input.throughTurnRequestId,
    requestId: input.requestId,
    protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${FORK_HASH_DOMAIN}\0${canonical}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function matchesIdentity(
  identity: CodexChatForkIdentityMetadata,
  expected: {
    requestId: string;
    requestHash: string;
    parentSessionId: string;
    throughTurnRequestId: string;
  },
): boolean {
  return (
    identity.family === "codex-chat-fork" &&
    identity.requestId === expected.requestId &&
    identity.requestHash === expected.requestHash &&
    identity.parentSessionId === expected.parentSessionId &&
    identity.throughTurnRequestId === expected.throughTurnRequestId
  );
}

/** Browser transport; native effects remain behind the audited operator routes. */
export function createCodexChatForkClient(
  dependencies: CodexChatForkClientDependencies,
): CodexChatForkClient {
  let reviewed = new WeakMap<object, ReviewProof>();
  const reserved = new Map<string, ReservedFork>(),
    busy = new Set<string>();
  let disposed = false;

  const check = (scope: ForkClientScope, signal?: AbortSignal) =>
    assertScope(dependencies, scope, signal, disposed);
  const get = async (
    path: string,
    scope: ForkClientScope,
    signal?: AbortSignal,
  ): Promise<unknown | null> => {
    check(scope, signal);
    const response = await dependencies.read(
      path,
      { method: "GET", ...(signal ? { signal } : {}) },
      { maxBodyBytes: RESPONSE_LIMIT },
    );
    check(scope, signal);
    const data = await responseData(response, signal);
    check(scope, signal);
    return data;
  };
  const post = async (
    path: string,
    body: unknown,
    scope: ForkClientScope,
  ): Promise<unknown> => {
    check(scope);
    const response = await dependencies.post(path, body, {
      maxBodyBytes: RESPONSE_LIMIT,
    });
    check(scope);
    const data = await responseData(response);
    check(scope);
    if (data === null)
      throw new Error(
        "The Fork action could not be confirmed; its original is held.",
      );
    return data;
  };

  const readOriginal = async (
    projectId: string,
    requestId: string,
    scope: ForkClientScope,
  ): Promise<CodexChatForkIdentityMetadata | null> => {
    const parsedRequestId = sessionRequestIdSchema.safeParse(requestId);
    if (!parsedRequestId.success || projectId !== scope.projectId) return null;
    const data = await get(
      `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(projectId)}/codex-chat-forks/${encodeURIComponent(requestId)}`,
      scope,
    );
    if (data === null) return null;
    const parsed = codexChatForkIdentityMetadataSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  };

  const readOperationPage = async (
    projectId: string,
    scope: ForkClientScope,
  ) => {
    const data = await get(
      `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(projectId)}/session-operation-identities`,
      scope,
    );
    if (data === null)
      throw new Error("Fork identity discovery could not be verified.");
    const parsed = sessionOperationIdentityPageSchema.safeParse(data);
    if (
      !parsed.success ||
      parsed.data.scope.projectId !== scope.projectId ||
      workspaceKey(parsed.data.scope.workspace) !== scope.workspace
    )
      throw new Error("Fork identity discovery could not be verified.");
    return parsed.data;
  };

  const readContext = async (
    projectId: string,
    requestId: string,
    after = 0,
    signal?: AbortSignal,
  ): Promise<CodexChatForkContextPage> => {
    const scope = snapshotScope(dependencies.currentScope());
    if (
      projectId !== scope.projectId ||
      !sessionRequestIdSchema.safeParse(requestId).success ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      throw new Error("The exact Fork original is unavailable in this scope.");
    const data = await get(
      `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(projectId)}/codex-chat-forks/${encodeURIComponent(requestId)}/context?after=${after}&limit=${PAGE_LIMIT}`,
      scope,
      signal,
    );
    const parsed = codexChatForkContextPageSchema.safeParse(data);
    if (!parsed.success || parsed.data.requestId !== requestId)
      throw new Error("The exact Fork context could not be verified.");
    if (
      parsed.data.available &&
      parsed.data.source &&
      new TextEncoder().encode(
        JSON.stringify({ ok: true, data: parsed.data, error: null }),
      ).byteLength > RESPONSE_LIMIT
    )
      throw new Error("The exact Fork context exceeds its response limit.");
    return parsed.data;
  };

  return {
    async reviewSource(input, signal) {
      const scope = snapshotScope(dependencies.currentScope());
      if (
        input.projectId !== scope.projectId ||
        !sessionRequestIdSchema.safeParse(input.throughTurnRequestId).success ||
        !/^session-[0-9a-f-]{36}$/.test(input.parentSessionId)
      )
        throw new Error(
          "Select one exact completed Fork source in this workspace.",
        );
      let after = 0,
        first: CodexChatForkSourcePage | null = null,
        frames: CodexChatForkSourcePage["frames"] = [],
        pageCount = 0;
      const seen = new Set<number>();
      for (;;) {
        if (++pageCount > PAGE_COUNT_LIMIT)
          throw new Error("The complete Fork source exceeds its page limit.");
        const path = `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(input.projectId)}/sessions/${encodeURIComponent(input.parentSessionId)}/fork-review?throughTurnRequestId=${encodeURIComponent(input.throughTurnRequestId)}&after=${after}&limit=${PAGE_LIMIT}`;
        const data = await get(path, scope, signal);
        const parsed = codexChatForkSourcePageSchema.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.projectId !== input.projectId ||
          parsed.data.parentSessionId !== input.parentSessionId ||
          parsed.data.requestId !== null ||
          parsed.data.throughTurnRequestId !== input.throughTurnRequestId ||
          (first !== null && !sameSource(first, parsed.data))
        )
          throw new Error("The selected Fork source changed during review.");
        first ??= parsed.data;
        for (const frame of parsed.data.frames) {
          if (frame.seq <= after || seen.has(frame.seq))
            throw new Error(
              "The Fork source pages do not form one complete history.",
            );
          seen.add(frame.seq);
          frames.push(frame);
        }
        if (frames.length > PAGE_LIMIT * PAGE_COUNT_LIMIT)
          throw new Error("The complete Fork source exceeds its frame limit.");
        if (parsed.data.complete) {
          if (parsed.data.nextCursor !== null) {
            throw new Error(
              "The Fork source page has an invalid completion cursor.",
            );
          }
          if (
            !frames.some(
              (frame) =>
                frame.kind === "user" &&
                frame.turnId === input.throughTurnRequestId,
            )
          )
            throw new Error(
              "The exact selected Fork turn is absent from the source.",
            );
          const complete = codexChatForkCompleteSourceSchema.parse({
            ...first,
            frames,
            complete: true,
            nextCursor: null,
          });
          if (
            new TextEncoder().encode(
              JSON.stringify({ ok: true, data: complete, error: null }),
            ).byteLength > RESPONSE_LIMIT
          )
            throw new Error(
              "The complete Fork source exceeds its response limit.",
            );
          reviewed.set(complete, { scope, source: complete });
          return complete;
        }
        if (
          parsed.data.nextCursor === null ||
          parsed.data.nextCursor <= after ||
          parsed.data.nextCursor !== parsed.data.frames.at(-1)?.seq
        )
          throw new Error("The Fork source cursor did not advance safely.");
        after = parsed.data.nextCursor;
      }
    },
    async reserveFork(input) {
      const scope = snapshotScope(dependencies.currentScope()),
        sourceProof = reviewed.get(input.source),
        busyKey = JSON.stringify([
          scope.projectId,
          scope.workspace,
          input.parentSessionId,
          input.throughTurnRequestId,
        ]);
      if (
        disposed ||
        !dependencies.canWrite() ||
        input.projectId !== scope.projectId ||
        !sourceProof ||
        !sameScope(sourceProof.scope, scope) ||
        sourceProof.source !== input.source ||
        input.source.projectId !== input.projectId ||
        input.source.parentSessionId !== input.parentSessionId ||
        input.source.throughTurnRequestId !== input.throughTurnRequestId ||
        !input.source.complete ||
        busy.has(busyKey)
      )
        throw new Error(
          "Review the exact Fork source again before reserving it.",
        );
      busy.add(busyKey);
      try {
        const request = intentSchema.parse({
            requestId: dependencies.requestId(),
            throughTurnRequestId: input.throughTurnRequestId,
          }),
          requestHash = await originalRequestHash({
            projectId: input.projectId,
            workspace: scope.workspace,
            parentSessionId: input.parentSessionId,
            throughTurnRequestId: input.throughTurnRequestId,
            requestId: request.requestId,
          });
        check(scope);
        if (!dependencies.canWrite())
          throw new Error("Writes are unavailable in this Fork scope.");
        const pendingIdentity: CodexChatForkIdentityMetadata = {
          family: "codex-chat-fork",
          requestId: request.requestId,
          requestHash,
          parentSessionId: input.parentSessionId,
          throughTurnRequestId: request.throughTurnRequestId,
          state: "reserved",
        };
        const pending: ReservedFork = {
          scope,
          parentSessionId: input.parentSessionId,
          intent: request,
          identity: pendingIdentity,
          dispatched: false,
          confirmed: false,
          notSent: false,
        };
        reserved.set(request.requestId, pending);
        let data: unknown;
        try {
          data = await post(
            `/__agent-forge/projects/${encodeURIComponent(input.projectId)}/sessions/${encodeURIComponent(input.parentSessionId)}/fork-reservations`,
            request,
            scope,
          );
        } catch {
          // Keep the exact generated identity for GET-only recovery; never mint a
          // replacement UUID after an ambiguous reservation reply.
          return pendingIdentity;
        }
        const parsed = codexChatForkIdentityMetadataSchema.safeParse(data);
        if (
          !parsed.success ||
          !matchesIdentity(parsed.data, {
            requestId: request.requestId,
            requestHash,
            parentSessionId: input.parentSessionId,
            throughTurnRequestId: request.throughTurnRequestId,
          }) ||
          parsed.data.state !== "reserved"
        )
          throw new Error(
            "The durable Fork reservation could not be verified.",
          );
        pending.identity = parsed.data;
        pending.confirmed = true;
        return parsed.data;
      } finally {
        busy.delete(busyKey);
      }
    },
    async dispatchReservedFork(projectId, requestId) {
      const entry = reserved.get(requestId);
      if (
        disposed ||
        !entry ||
        entry.scope.projectId !== projectId ||
        entry.dispatched ||
        !entry.confirmed ||
        !dependencies.canWrite()
      )
        return { state: "held" };
      let current: ForkClientScope;
      try {
        current = snapshotScope(dependencies.currentScope());
        check(entry.scope);
      } catch {
        return { state: "held" };
      }
      if (!sameScope(entry.scope, current)) return { state: "held" };
      entry.dispatched = true;
      try {
        const data = await post(
          `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(entry.parentSessionId)}/forks`,
          entry.intent,
          entry.scope,
        );
        const parsed = codexChatForkIdentityMetadataSchema.safeParse(data);
        if (
          !parsed.success ||
          !matchesIdentity(parsed.data, {
            requestId,
            requestHash: entry.identity.requestHash,
            parentSessionId: entry.parentSessionId,
            throughTurnRequestId: entry.intent.throughTurnRequestId,
          })
        )
          return { state: "held" };
        if (parsed.data.state === "linked") return { state: "linked" };
        if (parsed.data.state === "retired") return { state: "retired" };
        return { state: "held" };
      } catch (error) {
        // A reply loss never reuses this POST. Recovery is an explicit read.
        if (error instanceof NotSent && entry) entry.notSent = true;
        return { state: "held" };
      }
    },
    canDispatchReservedFork(requestId) {
      const entry = reserved.get(requestId);
      if (
        disposed ||
        !entry?.confirmed ||
        entry.dispatched ||
        !dependencies.canWrite()
      )
        return false;
      try {
        check(entry.scope);
        return true;
      } catch {
        return false;
      }
    },
    canRetireFork(requestId) {
      const entry = reserved.get(requestId);
      if (
        disposed ||
        !entry?.confirmed ||
        (entry.dispatched && !entry.notSent) ||
        entry.identity.state !== "reserved" ||
        !dependencies.canWrite()
      )
        return false;
      try {
        check(entry.scope);
        return true;
      } catch {
        return false;
      }
    },
    async recoverOriginal(projectId, requestId) {
      let scope: ForkClientScope;
      try {
        scope = snapshotScope(dependencies.currentScope());
        if (projectId !== scope.projectId) throw new Error();
        check(scope);
      } catch {
        return { state: "held", identity: null, original: null, context: null };
      }
      let page: Awaited<ReturnType<typeof readOperationPage>>;
      try {
        page = await readOperationPage(projectId, scope);
      } catch {
        return { state: "held", identity: null, original: null, context: null };
      }
      const operation = page.operations.find(
        (row) =>
          row.family === "codex-chat-fork" && row.requestId === requestId,
      );
      if (!operation || operation.family !== "codex-chat-fork")
        return { state: "held", identity: null, original: null, context: null };
      const identity = operation;
      const original = await readOriginal(projectId, requestId, scope);
      if (
        !original ||
        !matchesIdentity(original, identity) ||
        original.state !== identity.state
      )
        return { state: "held", identity, original: null, context: null };
      const expectedHash = await originalRequestHash({
        projectId,
        workspace: scope.workspace,
        parentSessionId: identity.parentSessionId,
        throughTurnRequestId: identity.throughTurnRequestId,
        requestId,
      });
      if (expectedHash !== identity.requestHash)
        return { state: "held", identity, original: null, context: null };
      let context: CodexChatForkContextPage | null = null;
      try {
        context = await readContext(projectId, requestId, 0);
      } catch {
        // A missing historical source does not settle the original. Linked child
        // transcript and controls use their own source-independent reads.
      }
      if (
        context &&
        (context.requestId !== identity.requestId ||
          context.requestHash !== identity.requestHash ||
          context.parentSessionId !== identity.parentSessionId ||
          context.throughTurnRequestId !== identity.throughTurnRequestId ||
          context.state !== identity.state ||
          (context.source !== null &&
            (context.source.projectId !== projectId ||
              context.source.parentSessionId !== identity.parentSessionId ||
              context.source.throughTurnRequestId !==
                identity.throughTurnRequestId ||
              context.source.requestId !== identity.requestId)))
      )
        context = null;
      if (original.state === "reserved" && context?.available) {
        reserved.set(requestId, {
          scope,
          parentSessionId: original.parentSessionId,
          intent: intentSchema.parse({
            requestId,
            throughTurnRequestId: original.throughTurnRequestId,
          }),
          identity: original,
          dispatched: false,
          confirmed: true,
          notSent: false,
        });
      }
      return {
        state:
          (original.state === "reserved" || original.state === "linked") &&
          context?.available === true
            ? "verified"
            : "held",
        identity,
        original,
        context,
      };
    },
    async listOriginals(projectId) {
      const scope = snapshotScope(dependencies.currentScope());
      if (projectId !== scope.projectId)
        throw new Error(
          "Fork identity discovery is unavailable in this scope.",
        );
      check(scope);
      const page = await readOperationPage(projectId, scope);
      return page.operations.filter(
        (row): row is CodexChatForkIdentityMetadata =>
          row.family === "codex-chat-fork",
      );
    },
    readContext,
    async readChildTurns(
      projectId,
      childSessionId,
      requestId,
      after = 0,
      signal,
    ) {
      const scope = snapshotScope(dependencies.currentScope());
      if (
        projectId !== scope.projectId ||
        !sessionRequestIdSchema.safeParse(requestId).success ||
        !Number.isSafeInteger(after) ||
        after < 0
      )
        throw new Error(
          "The Fork child transcript is unavailable in this scope.",
        );
      const data = await get(
        `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childSessionId)}/fork-turns?after=${after}&limit=100&requestId=${encodeURIComponent(requestId)}`,
        scope,
        signal,
      );
      const parsed = ownedCodingPageSchema.safeParse(data);
      if (
        !parsed.success ||
        parsed.data.projectId !== projectId ||
        parsed.data.conversationId !== childSessionId ||
        parsed.data.binding?.provider !== "codex"
      )
        throw new Error(
          "The exact Fork-child transcript could not be verified.",
        );
      return parsed.data;
    },
    async readChildApprovals(projectId, childSessionId, requestId, signal) {
      const scope = snapshotScope(dependencies.currentScope());
      if (projectId !== scope.projectId)
        throw new Error(
          "Fork-child permissions are unavailable in this scope.",
        );
      const query = requestId
        ? `?requestId=${encodeURIComponent(requestId)}`
        : "";
      const data = await get(
        `${OPERATOR_API_PREFIX}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childSessionId)}/fork-approvals${query}`,
        scope,
        signal,
      );
      const parsed = codexChatApprovalPageSchema.safeParse(data);
      if (!parsed.success)
        throw new Error("Fork-child permissions could not be verified.");
      return parsed.data;
    },
    async sendChildTurn(projectId, childSessionId, body) {
      const scope = snapshotScope(dependencies.currentScope());
      if (projectId !== scope.projectId || !dependencies.canWrite())
        throw new Error("Fork-child writes are unavailable in this scope.");
      return post(
        `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childSessionId)}/fork-turns`,
        body,
        scope,
      );
    },
    async decideChildApproval(projectId, childSessionId, body) {
      const scope = snapshotScope(dependencies.currentScope());
      if (projectId !== scope.projectId || !dependencies.canWrite())
        throw new Error("Fork-child permission decisions are unavailable.");
      return post(
        `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childSessionId)}/fork-approval-decisions`,
        body,
        scope,
      );
    },
    async stopChild(projectId, childSessionId, requestId) {
      const scope = snapshotScope(dependencies.currentScope());
      if (
        projectId !== scope.projectId ||
        !sessionRequestIdSchema.safeParse(requestId).success ||
        !dependencies.canWrite()
      )
        throw new Error("Fork-child Stop is unavailable in this scope.");
      return post(
        `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childSessionId)}/fork-stop`,
        { requestId },
        scope,
      );
    },
    async retireFork(projectId, requestId) {
      const entry = reserved.get(requestId);
      if (
        disposed ||
        !entry ||
        entry.scope.projectId !== projectId ||
        (entry.dispatched && !entry.notSent) ||
        !entry.confirmed ||
        entry.identity.state !== "reserved" ||
        !dependencies.canWrite()
      )
        throw new Error(
          "Only the exact unattempted Fork reservation can be retired.",
        );
      check(entry.scope);
      const data = await post(
        `/__agent-forge/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(entry.parentSessionId)}/fork-reservations/${encodeURIComponent(requestId)}/retire`,
        { requestHash: entry.identity.requestHash },
        entry.scope,
      );
      const parsed = codexChatForkIdentityMetadataSchema.safeParse(data);
      if (
        !parsed.success ||
        !matchesIdentity(parsed.data, {
          requestId,
          requestHash: entry.identity.requestHash,
          parentSessionId: entry.parentSessionId,
          throughTurnRequestId: entry.intent.throughTurnRequestId,
        }) ||
        parsed.data.state !== "retired"
      )
        throw new Error("The exact Fork retirement could not be verified.");
      reserved.delete(requestId);
      return parsed.data;
    },
    dispose() {
      disposed = true;
      reviewed = new WeakMap();
      reserved.clear();
      busy.clear();
    },
  };
}

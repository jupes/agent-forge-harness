import { describe, expect, test } from "bun:test";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationPage } from "../../types/conversation";
import type { SessionStartIdentityPage } from "../../types/session-start-identities";
import {
  canContinueClaudeRateLimit,
  continuationDraftFingerprint,
  continuationDraftIsDirty,
  CONTINUATION_SUMMARY_LIMIT,
  validContinuationSummary,
  type ClaudeContinuationSourceState,
} from "../../apps/desktop/src/session-continuation";

const projectId = "project-alpha",
  sessionId = "session-claude-1",
  requestId = "request-claude-1",
  workspace = "C:/work/alpha",
  repository = "C:/work/alpha/repo",
  worktree = "C:/work/alpha/repo";

const record: OwnedCodingSessionRecord = {
  provider: "claude",
  mode: "chat",
  projectId,
  id: sessionId,
  requestId,
  requestHash: "a".repeat(64),
  createdAt: "2026-10-29T12:00:00.000Z",
  workspace,
  repository,
  worktree,
  smith: "claude-default",
  requestedModel: "sonnet",
  requestedEffort: null,
};

const identityPage: SessionStartIdentityPage = {
  version: 1,
  scope: { family: "owned-session-start", projectId, workspace },
  identities: [],
};

const page: ConversationPage = {
  version: 1,
  projectId,
  conversationId: sessionId,
  revision: 2,
  binding: {
    provider: "claude",
    sessionId: "ca73d33d-d021-497e-a15d-8dec74b718ad",
    version: "2.1.0",
  },
  turns: [
    {
      requestId,
      hash: "b".repeat(64),
      phase: "failed",
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:05.000Z",
      reason: "The provider reported a limit.",
      owner: null,
    },
  ],
  frames: [
    {
      seq: 1,
      turnId: requestId,
      at: "2026-10-29T12:00:00.000Z",
      event: {
        kind: "user",
        text: "Original private prompt",
        about: [],
        session: {
          version: 1,
          provider: "claude",
          smith: record.smith,
          cwd: worktree,
          launch: {
            mode: "chat",
            model: "sonnet",
            prompt: "Original private prompt",
            context: { projectId, repository, worktree },
          },
          capabilities: { version: "2.1.0", flags: [] },
        },
      },
    },
    {
      seq: 2,
      turnId: requestId,
      at: "2026-10-29T12:00:05.000Z",
      event: {
        kind: "coding-outcome",
        provider: "claude",
        version: "2.1.0",
        code: "rate-limited",
        exitCode: 1,
        timedOut: false,
        stopped: false,
        message: null,
        stderrTail: { text: "", truncated: false },
      },
    },
  ],
  more: false,
  nextCursor: 2,
  lastSequence: 2,
  request: null,
  controllable: false,
};

function source(
  overrides: Partial<ClaudeContinuationSourceState> = {},
): ClaudeContinuationSourceState {
  return {
    projectId,
    workspace,
    writable: true,
    archived: false,
    record,
    page,
    loaded: true,
    live: true,
    feedInterrupted: false,
    readError: "",
    stopping: false,
    stopPosting: false,
    stopUnknown: false,
    pending: false,
    posting: false,
    identity: {
      page: identityPage,
      loading: false,
      generation: 1,
      startIdentity: null,
      pendingStart: false,
      starting: false,
      startIdentityError: "",
      legacyIdentityError: "",
      legacyIdentityUnavailable: false,
      inspection: null,
    },
    ...overrides,
  };
}

describe("reviewed provider continuation eligibility", () => {
  test("allows a complete current same-turn failed Claude rate limit", () => {
    expect(canContinueClaudeRateLimit(source())).toBe(true);
  });

  test("rejects task, managed, mismatched, active, stale, and errored sources", () => {
    expect(
      canContinueClaudeRateLimit(
        source({ record: { ...record, mode: "task" } }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          record: {
            ...record,
            origin: {
              kind: "shift",
              projectId,
              originalRequestId: requestId,
              shiftId: "shift-1",
              runId: "run-1",
              beadId: "bead-1",
              attempt: 1,
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({ page: { ...page, turns: [{ ...page.turns[0]!, phase: "unknown" }] } }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          page: {
            ...page,
            binding: { ...page.binding!, version: "2.2.0" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          page: {
            ...page,
            frames: [
              page.frames[0]!,
              {
                ...page.frames[1]!,
                event: {
                  kind: "coding-outcome",
                  provider: "claude",
                  version: "2.1.0",
                  code: "provider-error",
                  exitCode: 1,
                  timedOut: false,
                  stopped: false,
                  message: null,
                  stderrTail: { text: "", truncated: false },
                },
              },
            ],
          },
        }),
      ),
    ).toBe(false);
    expect(canContinueClaudeRateLimit(source({ live: false }))).toBe(false);
    expect(canContinueClaudeRateLimit(source({ feedInterrupted: true }))).toBe(
      false,
    );
    expect(canContinueClaudeRateLimit(source({ readError: "unavailable" }))).toBe(
      false,
    );
    expect(canContinueClaudeRateLimit(source({ archived: true }))).toBe(false);
    expect(canContinueClaudeRateLimit(source({ writable: false }))).toBe(false);
  });

  test("requires a current target identity page with no unresolved Start", () => {
    expect(canContinueClaudeRateLimit(source({ identity: { ...source().identity, loading: true } }))).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          identity: { ...source().identity, pendingStart: true },
        }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          identity: {
            ...source().identity,
            page: { ...identityPage, scope: { ...identityPage.scope, workspace: "C:/elsewhere" } },
          },
        }),
      ),
    ).toBe(false);
    expect(
      canContinueClaudeRateLimit(
        source({
          identity: {
            ...source().identity,
            page: {
              ...identityPage,
              identities: [
                {
                  version: 1,
                  requestId: "held-request",
                  requestHash: "c".repeat(64),
                  provider: "codex",
                  mode: "chat",
                  state: "attempted",
                },
              ],
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("continuation summary and draft replacement", () => {
  test("bounds the operator-authored summary and recognizes dirty common drafts", () => {
    expect(validContinuationSummary("  A short handoff.  ")).toBe(true);
    expect(validContinuationSummary(" \n ")).toBe(false);
    expect(validContinuationSummary("x".repeat(CONTINUATION_SUMMARY_LIMIT + 1))).toBe(
      false,
    );
    const clean = { prompt: "", attachments: [], about: [] };
    expect(continuationDraftIsDirty(clean)).toBe(false);
    expect(
      continuationDraftIsDirty({ ...clean, prompt: "existing draft" }),
    ).toBe(true);
    expect(
      continuationDraftIsDirty({ ...clean, about: [{ kind: "session", id: sessionId }] }),
    ).toBe(true);
    expect(continuationDraftFingerprint(clean)).not.toBe(
      continuationDraftFingerprint({ ...clean, prompt: "existing draft" }),
    );
  });
});

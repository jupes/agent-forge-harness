import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  sessionWorktreeReceiptSchema,
  sessionWorktreeRequestSchema,
} from "../../../scripts/sessions/worktree-protocol";
import type {
  SessionWorktreeReceipt,
  SessionWorktreeRequest,
} from "../../../types/session-worktrees";

export interface SessionWorktreeView {
  original: SessionWorktreeRequest | null;
  receipt: SessionWorktreeReceipt | null;
  posting: boolean;
  checking: boolean;
  notice: string;
}

/** App-root lifetime; an uncertain Git action never releases its original identity. */
export function createSessionWorktreeClient(deps: {
  canWrite(): boolean;
  requestId(): string;
  post(
    projectId: string,
    input: SessionWorktreeRequest,
  ): Promise<ActionOutcome>;
  read(projectId: string, requestId: string): Promise<unknown>;
  changed(): void;
}) {
  const projects = new Map<string, SessionWorktreeView>();
  const get = (projectId: string) => {
    let value = projects.get(projectId);
    if (!value) {
      value = {
        original: null,
        receipt: null,
        posting: false,
        checking: false,
        notice: "",
      };
      projects.set(projectId, value);
    }
    return value;
  };
  const accept = (projectId: string, raw: unknown) => {
    const entry = get(projectId),
      parsed = sessionWorktreeReceiptSchema.safeParse(raw),
      original = entry.original;
    if (entry.receipt && entry.receipt.state !== "unknown") return true;
    if (
      !parsed.success ||
      !original ||
      parsed.data.projectId !== projectId ||
      parsed.data.requestId !== original.requestId ||
      workspaceKey(parsed.data.repository) !==
        workspaceKey(original.repository) ||
      parsed.data.baseRef !== original.baseRef ||
      parsed.data.branch !== original.branch
    ) {
      entry.notice =
        "The worktree receipt could not be verified. Keep the original request and check it again.";
      return false;
    }
    // A delayed uncertain response cannot undo a confirmed terminal receipt.
    if (
      entry.receipt?.state !== "created" &&
      entry.receipt?.state !== "refused"
    )
      entry.receipt = parsed.data;
    entry.notice =
      entry.receipt?.state === "created"
        ? "Worktree created. Review its path before checking session options."
        : (entry.receipt?.reason ??
          "The original worktree request is still uncertain.");
    return true;
  };
  const post = async (projectId: string, retry: boolean) => {
    const entry = get(projectId),
      original = entry.original;
    if (
      !original ||
      entry.posting ||
      !deps.canWrite() ||
      (entry.receipt && entry.receipt.state !== "unknown")
    )
      return;
    entry.posting = true;
    entry.notice = "Creating the explicitly requested worktree…";
    deps.changed();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(projectId, structuredClone(original));
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The worktree outcome is unknown. Check the original request before trying again.",
      };
    }
    entry.posting = false;
    if (entry.original?.requestId !== original.requestId) return;
    if (outcome.state === "done") accept(projectId, outcome.data);
    else if (!entry.receipt || entry.receipt.state === "unknown") {
      entry.notice = outcome.message;
      // A preflight refusal has no durable Git intent; a fresh explicit action is safe.
      if (outcome.state === "refused" && !retry) entry.original = null;
    }
    deps.changed();
  };
  return {
    get,
    async create(
      projectId: string,
      input: Omit<SessionWorktreeRequest, "requestId">,
    ) {
      const entry = get(projectId);
      if (entry.original || entry.posting || !deps.canWrite()) return;
      const parsed = sessionWorktreeRequestSchema.safeParse({
        ...input,
        requestId: deps.requestId(),
      });
      if (!parsed.success) {
        entry.notice =
          "Choose a valid repository, base ref and new branch before creating a worktree.";
        deps.changed();
        return;
      }
      entry.original = structuredClone(parsed.data);
      entry.receipt = null;
      await post(projectId, false);
    },
    retry: (projectId: string) => post(projectId, true),
    async check(projectId: string) {
      const entry = get(projectId),
        original = entry.original;
      if (!original || entry.checking) return;
      entry.checking = true;
      deps.changed();
      try {
        const raw = await deps.read(projectId, original.requestId);
        if (entry.original?.requestId === original.requestId)
          accept(projectId, raw);
      } catch {
        if (!entry.receipt || entry.receipt.state === "unknown")
          entry.notice =
            "The original worktree request could not be found or verified. Its identity is kept; checking does not create another worktree.";
      } finally {
        entry.checking = false;
        deps.changed();
      }
    },
    another(projectId: string) {
      const entry = get(projectId);
      if (
        entry.posting ||
        entry.checking ||
        !entry.receipt ||
        entry.receipt.state === "unknown"
      )
        return;
      entry.original = null;
      entry.receipt = null;
      entry.notice =
        "Choose a new branch and explicitly create another worktree.";
      deps.changed();
    },
  };
}

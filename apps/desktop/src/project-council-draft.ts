export type ProjectCouncilDraft = {
  sourceType: "bead" | "pr" | "plan" | "file" | "text";
  source: string;
  profileChoice: string;
  maxUsd: string;
  maxBytes: string;
  redactSecrets: boolean;
  deepDiscussion: boolean;
};

export type ProjectCouncilDraftScope = {
  projectId: string;
  workspace: string;
};

export type ProjectCouncilSourcePrefill = Pick<
  ProjectCouncilDraft,
  "sourceType" | "source"
>;

export type PendingProjectCouncilSourceReplacement = Readonly<{
  scope: Readonly<ProjectCouncilDraftScope>;
  sourceType: ProjectCouncilSourcePrefill["sourceType"];
  source: string;
  expectedRevision: number;
}>;

type DraftSnapshot = { draft: ProjectCouncilDraft; revision: number };
type Refusal = {
  kind: "refused";
  reason: "capacity" | "source-too-large" | "invalid-scope";
};
type Applied = {
  kind: "applied";
  draft: ProjectCouncilDraft;
  revision: number;
};

const MAX_DRAFTS = 32;
const MAX_SOURCE_BYTES = 256 * 1024;

export function blankProjectCouncilDraft(): ProjectCouncilDraft {
  return {
    sourceType: "text",
    source: "",
    profileChoice: "",
    maxUsd: "3",
    maxBytes: "262144",
    redactSecrets: true,
    deepDiscussion: false,
  };
}

function copyDraft(draft: ProjectCouncilDraft): ProjectCouncilDraft {
  return { ...draft };
}

function scopeKey(scope: ProjectCouncilDraftScope): string | null {
  if (
    typeof scope.projectId !== "string" ||
    scope.projectId.length === 0 ||
    typeof scope.workspace !== "string" ||
    scope.workspace.length === 0
  )
    return null;
  return JSON.stringify([scope.projectId, scope.workspace]);
}

function sourceIsValid(source: ProjectCouncilSourcePrefill): boolean {
  return (
    typeof source.source === "string" &&
    new TextEncoder().encode(source.source).byteLength <= MAX_SOURCE_BYTES
  );
}

function copySnapshot(snapshot: DraftSnapshot): DraftSnapshot {
  return { draft: copyDraft(snapshot.draft), revision: snapshot.revision };
}

export function createProjectCouncilDraftCache(): {
  read(scope: ProjectCouncilDraftScope): DraftSnapshot | undefined;
  write(
    scope: ProjectCouncilDraftScope,
    draft: ProjectCouncilDraft,
  ): (DraftSnapshot & { kind: "saved" }) | Refusal;
  prefill(
    scope: ProjectCouncilDraftScope,
    source: ProjectCouncilSourcePrefill,
  ):
    | Applied
    | {
        kind: "confirmation-required";
        draft: ProjectCouncilDraft;
        pending: PendingProjectCouncilSourceReplacement;
        revision: number;
      }
    | Refusal;
  confirm(
    scope: ProjectCouncilDraftScope,
    pending: PendingProjectCouncilSourceReplacement,
  ):
    | Applied
    | { kind: "stale"; draft: ProjectCouncilDraft; revision: number }
    | Refusal;
} {
  const entries = new Map<string, DraftSnapshot>();
  let nextRevision = 1;

  function save(key: string, draft: ProjectCouncilDraft): DraftSnapshot {
    const snapshot = { draft: copyDraft(draft), revision: nextRevision++ };
    entries.set(key, snapshot);
    return copySnapshot(snapshot);
  }

  function canAdd(key: string): boolean {
    return entries.has(key) || entries.size < MAX_DRAFTS;
  }

  function withSource(
    draft: ProjectCouncilDraft,
    source: ProjectCouncilSourcePrefill,
  ): ProjectCouncilDraft {
    return { ...draft, sourceType: source.sourceType, source: source.source };
  }

  function refusal(
    key: string | null,
    source?: ProjectCouncilSourcePrefill,
  ): Refusal | null {
    if (key === null) return { kind: "refused", reason: "invalid-scope" };
    if (source && !sourceIsValid(source))
      return { kind: "refused", reason: "source-too-large" };
    if (!canAdd(key)) return { kind: "refused", reason: "capacity" };
    return null;
  }

  return {
    read(scope) {
      const key = scopeKey(scope);
      if (key === null) return undefined;
      const current = entries.get(key);
      return current ? copySnapshot(current) : undefined;
    },
    write(scope, draft) {
      const key = scopeKey(scope);
      const denied = refusal(key, draft);
      if (denied) return denied;
      const snapshot = save(key as string, draft);
      return { ...snapshot, kind: "saved" };
    },
    prefill(scope, source) {
      const key = scopeKey(scope);
      const denied = refusal(key, source);
      if (denied) return denied;
      const current = key === null ? undefined : entries.get(key);
      const draft = current?.draft ?? blankProjectCouncilDraft();
      if (
        draft.source.length > 0 &&
        (draft.source !== source.source ||
          draft.sourceType !== source.sourceType)
      ) {
        const pending = Object.freeze({
          scope: Object.freeze({ ...scope }),
          sourceType: source.sourceType,
          source: source.source,
          expectedRevision: current?.revision ?? 0,
        });
        return {
          kind: "confirmation-required",
          draft: copyDraft(draft),
          pending,
          revision: current?.revision ?? 0,
        };
      }
      const snapshot = save(key as string, withSource(draft, source));
      return { kind: "applied", ...snapshot };
    },
    confirm(scope, pending) {
      const key = scopeKey(scope);
      const pendingKey = scopeKey(pending.scope);
      if (key === null || pendingKey === null || key !== pendingKey)
        return { kind: "refused", reason: "invalid-scope" };
      const denied = refusal(key, pending);
      if (denied) return denied;
      const current = entries.get(key);
      if (!current || current.revision !== pending.expectedRevision)
        return {
          kind: "stale",
          draft: current
            ? copyDraft(current.draft)
            : blankProjectCouncilDraft(),
          revision: current?.revision ?? 0,
        };
      const snapshot = save(key, withSource(current.draft, pending));
      return { kind: "applied", ...snapshot };
    },
  };
}

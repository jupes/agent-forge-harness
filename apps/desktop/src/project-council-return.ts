import type { ProjectCouncilDraftScope } from "./project-council-draft";

export type ProjectCouncilReturnOrigin = Readonly<{
  kind: "run-checkpoint";
  projectId: string;
  workspace: string;
  runSlug: string;
  checkpointId: string;
}>;

export type ProjectCouncilSourceIntent = Readonly<{
  scope: ProjectCouncilDraftScope;
  generation: number;
  returnOrigin: ProjectCouncilReturnOrigin | null;
}>;

export type ProjectCouncilReturnFocus = Readonly<{
  origin: ProjectCouncilReturnOrigin;
  generation: number;
}>;

export function projectCouncilReturnTargetMatches(
  origin: ProjectCouncilReturnOrigin,
  scope: ProjectCouncilDraftScope,
  runSlug: string,
  inProgressCheckpointIds: readonly string[],
): boolean {
  return (
    origin.projectId === scope.projectId &&
    origin.workspace === scope.workspace &&
    origin.runSlug === runSlug &&
    inProgressCheckpointIds.includes(origin.checkpointId)
  );
}

function sameScope(
  left: ProjectCouncilDraftScope,
  right: ProjectCouncilDraftScope,
): boolean {
  return (
    left.projectId === right.projectId && left.workspace === right.workspace
  );
}

function sameOrigin(
  left: ProjectCouncilReturnOrigin,
  right: ProjectCouncilReturnOrigin,
): boolean {
  return (
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.workspace === right.workspace &&
    left.runSlug === right.runSlug &&
    left.checkpointId === right.checkpointId
  );
}

export function createProjectCouncilReturnMemory() {
  let generation = 0;
  let scope: ProjectCouncilDraftScope | null = null;
  let origin: ProjectCouncilReturnOrigin | null = null;

  const advance = (): number => {
    if (generation >= Number.MAX_SAFE_INTEGER)
      throw new Error("Council return generation limit reached.");
    generation += 1;
    return generation;
  };

  const isCurrent = (
    intent: ProjectCouncilSourceIntent,
    currentScope: ProjectCouncilDraftScope,
  ): boolean =>
    intent.generation === generation &&
    sameScope(intent.scope, currentScope) &&
    (!intent.returnOrigin ||
      (intent.returnOrigin.projectId === currentScope.projectId &&
        intent.returnOrigin.workspace === currentScope.workspace));

  return {
    begin(
      nextScope: ProjectCouncilDraftScope,
      returnOrigin: ProjectCouncilReturnOrigin | null,
    ): ProjectCouncilSourceIntent {
      const capturedOrigin =
        returnOrigin &&
        returnOrigin.projectId === nextScope.projectId &&
        returnOrigin.workspace === nextScope.workspace
          ? returnOrigin
          : null;
      return {
        scope: { ...nextScope },
        generation: advance(),
        returnOrigin: capturedOrigin,
      };
    },
    isCurrent,
    apply(
      intent: ProjectCouncilSourceIntent,
      currentScope: ProjectCouncilDraftScope,
    ): boolean {
      if (!isCurrent(intent, currentScope)) return false;
      scope = { ...currentScope };
      origin = intent.returnOrigin;
      advance();
      return true;
    },
    keep(
      intent: ProjectCouncilSourceIntent,
      currentScope: ProjectCouncilDraftScope,
    ): boolean {
      if (!isCurrent(intent, currentScope)) return false;
      advance();
      return true;
    },
    reject(
      intent: ProjectCouncilSourceIntent,
      currentScope: ProjectCouncilDraftScope,
    ): boolean {
      if (!isCurrent(intent, currentScope)) return false;
      advance();
      return true;
    },
    get(
      currentScope: ProjectCouncilDraftScope,
    ): ProjectCouncilReturnOrigin | null {
      return scope && sameScope(scope, currentScope) ? origin : null;
    },
    take(
      currentScope: ProjectCouncilDraftScope,
      expectedOrigin: ProjectCouncilReturnOrigin,
    ): ProjectCouncilReturnFocus | null {
      if (
        !scope ||
        !sameScope(scope, currentScope) ||
        !origin ||
        !sameOrigin(origin, expectedOrigin)
      )
        return null;
      const taken = origin;
      origin = null;
      scope = null;
      return { origin: taken, generation: advance() };
    },
    clear(): void {
      advance();
      scope = null;
      origin = null;
    },
  };
}

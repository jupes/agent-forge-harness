import { isDeepStrictEqual } from "node:util";
import type { KeeperReadQuery } from "../../../types/keeper";
import { ConversationError } from "../../conversations/error";
import type { ValidateConversationAbout } from "../../conversations/service";
import { KEEPER_OBJECT_READS } from "../../keeper/objects";
import {
  assertScopedProjectReference,
  type KeeperHistory,
  parseKeeperReadQuery,
  readKeeperProject,
} from "../../keeper/project-read";
import { queryEventPage } from "../../ledger/query";
import { effectiveKeeperVisibility } from "../../projects/project-keeper-protocol";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { ReadRoute } from "../api";
import { fail, hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

function recordedHistory(deps: ReadDeps): KeeperHistory {
  try {
    const page = queryEventPage(
      { workspace: deps.workspace, limit: 10_000 },
      hearthLedger(deps.ledgerPath),
    );
    return { events: page.events, more: page.more };
  } catch {
    return { events: null, more: false };
  }
}

function readableKeeperProject(home: string, id: string) {
  const catalog = createProjectStore(home).read();
  const project = catalog.projects.find((item) => item.id === id);
  if (!project)
    throw new ConversationError(
      404,
      "This project is not in the hearth catalog.",
    );
  if (effectiveKeeperVisibility(project).value === "conversation-only")
    throw new ConversationError(
      409,
      "Keeper project metadata reads are disabled by the current visibility policy.",
    );
  return { catalog, project };
}

function keeperProjectAfterRead(
  home: string,
  id: string,
  before: ReturnType<typeof readableKeeperProject>,
  snapshot: ProjectSnapshot,
) {
  const current = readableKeeperProject(home, id);
  const matches = snapshot.catalog.projects.filter((item) => item.id === id);
  if (
    before.catalog.revision !== snapshot.catalog.revision ||
    current.catalog.revision !== before.catalog.revision ||
    matches.length !== 1 ||
    !isDeepStrictEqual(before.project, current.project) ||
    !isDeepStrictEqual(before.project, matches[0])
  )
    throw new ConversationError(
      409,
      "The canonical Keeper project changed during the source read. No metadata was returned.",
    );
  return current;
}

/** Reuses the reader's exact membership rules, before any new turn is admitted. */
export function keeperAboutValidator(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ValidateConversationAbout {
  return async (projectId, about) => {
    const snapshot = await load();
    const project = snapshot.catalog.projects.find(
      (item) => item.id === projectId,
    );
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    const history = about.some((ref) => ref.kind === "event")
      ? recordedHistory(deps)
      : { events: [], more: false };
    for (const ref of about)
      readKeeperProject(
        project,
        snapshot.catalog.revision,
        snapshot.source,
        history,
        { kind: KEEPER_OBJECT_READS[ref.kind], id: ref.id },
      );
  };
}

/** Owned coding-session membership is independent of standing Keeper visibility. */
export function ownedSessionAboutValidator(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ValidateConversationAbout {
  return async (projectId, about) => {
    if (about.length === 0) return;
    const snapshot = await load();
    const project = snapshot.catalog.projects.find(
      (item) => item.id === projectId,
    );
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    const history = about.some((ref) => ref.kind === "event")
      ? recordedHistory(deps)
      : { events: [], more: false };
    for (const ref of about)
      assertScopedProjectReference(
        project,
        snapshot.catalog.revision,
        snapshot.source,
        history,
        { kind: KEEPER_OBJECT_READS[ref.kind], id: ref.id },
      );
  };
}

/** This row only reads the selected project's sources; the model has no action row. */
export function keeperReadRoute(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<{ id: string; query: KeeperReadQuery }> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/keeper/read",
    validate: (request) => {
      const id = request.params["id"];
      if (!isProjectId(id)) return fail("Expected a project id.");
      const input: Record<string, unknown> = {};
      for (const [key, value] of request.query) {
        if (
          !["kind", "id", "after", "limit"].includes(key) ||
          request.query.getAll(key).length !== 1
        )
          return fail("Unsupported project reader query.");
        if (key === "after" || key === "limit") {
          if (!/^\d+$/.test(value))
            return fail("Expected a bounded numeric cursor/page size.");
          input[key] = Number(value);
        } else input[key] = value;
      }
      try {
        return { ok: true, value: { id, query: parseKeeperReadQuery(input) } };
      } catch {
        return fail(
          "Expected a project read kind, optional id and bounded cursor/page size.",
        );
      }
    },
    read: async ({ id, query }) => {
      try {
        const before = readableKeeperProject(home, id);
        const snapshot = await load();
        const current = keeperProjectAfterRead(home, id, before, snapshot);
        const history: KeeperHistory =
          query.kind === "activity"
            ? recordedHistory(deps)
            : { events: [], more: false };
        return {
          status: 200,
          data: readKeeperProject(
            current.project,
            current.catalog.revision,
            snapshot.source,
            history,
            query,
          ),
        };
      } catch (error) {
        if (
          error instanceof ConversationError ||
          error instanceof ProjectStoreError
        )
          return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
}

import {
  ConversationError,
  createConversationStore,
} from "../../conversations/store";
import { keeperBriefs } from "../../keeper/brief-model";
import { buildKeeperBriefSnapshot } from "../../keeper/brief-snapshot";
import type { KeeperHistory } from "../../keeper/project-read";
import { queryEventPage } from "../../ledger/query";
import { createProjectStore } from "../../projects/store";
import { hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** Called only while the standing conversation owns its dispatch lease. */
export function createKeeperBriefPreparer(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  return async (projectId: string) => {
    const snapshot = await load();
    const current = createProjectStore(home).read();
    if (current.revision !== snapshot.catalog.revision)
      throw new ConversationError(
        409,
        "Project scope changed during the brief read. No turn was accepted.",
      );
    const project = current.projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is no longer in the hearth catalog.",
      );
    let history: KeeperHistory;
    try {
      const page = queryEventPage(
        { workspace: deps.workspace, limit: 10_000 },
        hearthLedger(deps.ledgerPath),
      );
      history = { events: page.events, more: page.more };
    } catch {
      history = { events: null, more: false };
    }
    const previous = keeperBriefs(
      createConversationStore(home).read(projectId),
    ).latest;
    return buildKeeperBriefSnapshot(
      project,
      current.revision,
      snapshot.source,
      history,
      previous?.snapshot.asOf,
    );
  };
}

import { createConversationStore } from "../../conversations/store";
import { keeperBriefs } from "../../keeper/brief-model";
import { buildKeeperBriefSnapshot } from "../../keeper/brief-snapshot";
import type { KeeperHistory } from "../../keeper/project-read";
import { queryEventPage } from "../../ledger/query";
import { keeperProjectAfterRead, readableKeeperProject } from "./keeper-read";
import { hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** Called only while the standing conversation owns its dispatch lease. */
export function createKeeperBriefPreparer(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  return async (projectId: string) => {
    const before = readableKeeperProject(home, projectId);
    const snapshot = await load();
    const current = keeperProjectAfterRead(home, projectId, before, snapshot);
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
      current.project,
      current.catalog.revision,
      snapshot.source,
      history,
      previous?.snapshot.asOf,
    );
  };
}

import type { CompleteTrackerReader } from "../../projects/complete-tracker-reader";
import { createWorkspaceSourceInstance } from "../../projects/connected-source-instance";
import { createConnectedSources } from "../../projects/connected-source-service";
import { workspaceSourceConnector } from "../../projects/connected-source-transport";
import { createScopeSettings } from "../../projects/scope-settings-service";
import { createProjectStore } from "../../projects/store";
import { connectedSourceRoutes } from "./connected-sources";
import { scopeSettingsRoutes } from "./scope-settings";

/** TEST ONLY. Preserve deferred1.1 endpoint/security coverage outside the production1.0 table. */
export function deferredProjectSettingsFixture(
  root: string,
  home: string,
  complete: CompleteTrackerReader,
) {
  const own = createWorkspaceSourceInstance({
    root,
    catalog: () => createProjectStore(home).read(),
    complete,
  });
  const sources = createConnectedSources({
    root,
    catalog: () => createProjectStore(home).read(),
    own,
    connect: workspaceSourceConnector(home),
  });
  const scope = createScopeSettings(home, sources),
    sourceRoutes = connectedSourceRoutes(sources, own),
    scopeRoutes = scopeSettingsRoutes(scope);
  return {
    reads: [...sourceRoutes.reads, scopeRoutes.original],
    actions: [...sourceRoutes.actions, scopeRoutes.save],
    deactivate() {
      scope.deactivate();
      sources.deactivate();
    },
  };
}

import type { ComponentChildren } from "preact";
import type { ProjectRecord } from "../../../types/projects";

/**1.0 exposes saved membership without authorizing or probing another workspace. */
export function SavedProjectScope({
  project,
}: {
  project: Pick<ProjectRecord, "workspaces">;
}) {
  return (
    <section
      class="af-project-repositories"
      aria-labelledby="project-scope-heading"
    >
      <h3 id="project-scope-heading">Scope</h3>
      <p>
        Saved Scope is read-only in 1.0. These epic selections continue to
        define project membership.
      </p>
      <p>
        Live multi-workspace previews and Scope editing are planned for 1.1.
        Saved paths do not grant access to other workspaces.
      </p>
      <div class="af-project-repositories-workspaces">
        {project.workspaces.map((workspace, index) => (
          <section
            class="af-project-repositories-workspace"
            key={workspace.root}
            aria-label={"Saved workspace " + (index + 1)}
          >
            <h4>Workspace {index + 1}</h4>
            <p style={{ overflowWrap: "anywhere" }}>
              <code>{workspace.root}</code>
            </p>
            <p>
              Saved epics:{" "}
              {workspace.epicIds.map((id, index) => (
                <span key={id}>
                  {index > 0 ? ", " : ""}
                  <code>{id}</code>
                </span>
              ))}
            </p>
          </section>
        ))}
      </div>
      <p role="status">
        This saved configuration does not verify live availability or a combined
        bead count.
      </p>
    </section>
  );
}
export function ForegroundNotifications() {
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-notifications-heading"
    >
      <h3 id="project-notifications-heading">Notifications</h3>
      <p>Updates and approval actions are available in Activity and Inbox.</p>
      <p role="status">
        Desktop notifications and background delivery are planned for 1.1. No
        notification permission is requested in 1.0.
      </p>
    </section>
  );
}
export function ForegroundAppSettings({
  children,
}: {
  children?: ComponentChildren;
} = {}) {
  return (
    <section class="af-project-settings" aria-labelledby="app-settings-heading">
      <h2 id="app-settings-heading">Settings</h2>
      {children}
      <ForegroundNotifications />
    </section>
  );
}

import {
  NO_PROJECT_NOTIFICATIONS,
  type ProjectNotifications,
  projectNotificationsSchema,
} from "../../../scripts/projects/project-notifications-protocol";
import {
  type ProjectValueDependencies,
  ProjectValueSettingsOwner,
  type ProjectValueSpec,
} from "./project-value-settings-client";

export const projectNotificationsSpec: ProjectValueSpec<ProjectNotifications> =
  {
    key: "notifications",
    label: "Notification preferences",
    parse: (value) =>
      projectNotificationsSchema.parse(
        value === undefined ? NO_PROJECT_NOTIFICATIONS : value,
      ),
  };
export const createProjectNotificationsOwner = (
  deps: ProjectValueDependencies,
) => new ProjectValueSettingsOwner(projectNotificationsSpec, deps);

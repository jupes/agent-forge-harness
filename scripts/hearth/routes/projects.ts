import type { ProjectPreferences } from "../../../types/projects";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { bodyFields, fail, noParameters } from "./operator-reads";

interface PreferenceChange {
  id: string;
  revision: number;
  patch: ProjectPreferences;
}

function preferenceChange(
  request: RouteRequest,
): ValidationResult<PreferenceChange> {
  const checked = bodyFields(request, ["revision", "pinned", "archived"]);
  if (!checked.ok) return checked;
  const { revision, pinned, archived } = checked.value;
  const id = request.params["id"];
  if (!isProjectId(id)) return fail("Expected a project id.");
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    return fail("Expected a project catalog revision.");
  if (
    (pinned === undefined && archived === undefined) ||
    (pinned !== undefined && typeof pinned !== "boolean") ||
    (archived !== undefined && typeof archived !== "boolean")
  )
    return fail("Expected a boolean pin or archive preference.");
  return {
    ok: true,
    value: {
      id,
      revision,
      patch: {
        ...(typeof pinned === "boolean" ? { pinned } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      },
    },
  };
}

async function reply(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (error instanceof ProjectStoreError)
      return { status: error.status, error: error.message };
    throw error;
  }
}

/** The runner owns origin/token/validation/audit ordering; this row only changes preferences. */
export function projectRoutes(home: string) {
  const store = createProjectStore(home);
  const projects: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/projects",
    validate: noParameters,
    read: () => reply(() => store.read()),
  };
  const preferences: ActionRoute<PreferenceChange> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/preferences",
    action: "project.preferences",
    validate: preferenceChange,
    subject: ({ id }) => ({ target: id }),
    effect: ({ id, revision, patch }) =>
      reply(() => store.preferences(id, revision, patch)),
  };
  return { projects, preferences };
}

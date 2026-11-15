import { z } from "zod";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { projectSessionObservationsSchema } from "../../../scripts/projects/session-observations-protocol";
import {
  type DeepLinkIndex,
  type DeepLinkTarget,
  deepLinkIndexSchema,
} from "./deep-link";

if (typeof window !== "undefined") z.config({ jitless: true });
const text = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const catalogSource = z.object({
  catalog: z.object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    projects: z
      .array(
        z.object({
          id: text.max(256),
          archived: z.boolean(),
          workspaces: z
            .array(
              z.object({
                root: text,
                repositories: z.array(text).max(1000),
                epicIds: z.array(text.max(256)).max(1000),
              }),
            )
            .max(100),
        }),
      )
      .max(100)
      .refine(
        (projects) =>
          new Set(projects.map((project) => project.id)).size ===
          projects.length,
      ),
  }),
});

export async function readDeepLinkIndex(options: {
  target: DeepLinkTarget;
  workspace: string;
  signal: AbortSignal;
  read(path: string, signal: AbortSignal): Promise<unknown>;
}): Promise<DeepLinkIndex> {
  const { signal, workspace } = options;
  if (!text.safeParse(workspace).success)
    throw Error("Link targets are unavailable.");
  const readCatalog = async () => {
    signal.throwIfAborted();
    const raw = await options.read("/projects/summary", signal);
    signal.throwIfAborted();
    const parsed = catalogSource.safeParse(raw);
    if (!parsed.success)
      throw Error("The project catalog could not be verified.");
    return parsed.data.catalog;
  };
  const catalog = await readCatalog();
  const projects: DeepLinkIndex["projects"] = catalog.projects.map(
    (project) => ({
      id: project.id,
      archived: project.archived,
      readable:
        project.workspaces.length === 1 &&
        project.workspaces.some(
          (scope) => workspaceKey(scope.root) === workspaceKey(workspace),
        ),
      beads: { complete: false, ids: [] },
      sessions: { complete: false, ids: [] },
    }),
  );
  if (options.target.kind !== "project") {
    const family = options.target.kind === "bead" ? "beads" : "sessions";
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        signal.throwIfAborted();
        const project = projects[cursor++];
        if (!project) return;
        if (!project.readable) continue;
        const suffix = family === "beads" ? "beads" : "session-observations";
        try {
          const raw = await options.read(
            "/projects/" + encodeURIComponent(project.id) + "/" + suffix,
            signal,
          );
          signal.throwIfAborted();
          if (family === "beads") {
            const parsed = projectBeadsPageSchema.safeParse(raw);
            if (
              parsed.success &&
              parsed.data.projectId === project.id &&
              workspaceKey(parsed.data.workspace) === workspaceKey(workspace)
            ) {
              project.beads = {
                complete:
                  parsed.data.complete && parsed.data.problems.length === 0,
                ids: parsed.data.beads.map((bead) => bead.id),
              };
            }
          } else {
            const parsed = projectSessionObservationsSchema.safeParse(raw);
            if (
              parsed.success &&
              parsed.data.projectId === project.id &&
              workspaceKey(parsed.data.workspace) === workspaceKey(workspace)
            ) {
              project.sessions = {
                complete:
                  parsed.data.observationsComplete &&
                  parsed.data.ownership.available &&
                  parsed.data.problems.length === 0,
                ids: [
                  ...new Set([
                    ...parsed.data.observations.map((row) => row.sessionId),
                    ...parsed.data.ownership.records.map(
                      (row) => row.record.id,
                    ),
                  ]),
                ],
              };
            }
          }
        } catch {
          signal.throwIfAborted();
          // A failed source remains incomplete; it never establishes absence.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, projects.length) }, worker),
    );
  }
  const after = await readCatalog();
  if (JSON.stringify(catalog) !== JSON.stringify(after))
    throw Error("The project catalog changed while opening the link.");
  signal.throwIfAborted();
  return deepLinkIndexSchema.parse({ revision: catalog.revision, projects });
}

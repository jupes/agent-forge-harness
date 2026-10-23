import { z } from "zod";
import { ConversationError } from "../../conversations/error";
import { activeReservations, queryEventPage } from "../../ledger/query";
import { projectBeads } from "../../projects/beads";
import { projectBeadsPageSchema } from "../../projects/beads-protocol";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ReadRoute } from "../api";
import { isBeadId } from "../tracker-write";
import { fail, hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

const commentsSchema = z
  .array(
    z.object({
      issue_id: z.string().max(200).optional(),
      text: z.string().max(16_384),
      author: z.string().max(1024),
      created_at: z.string().max(100),
    }),
  )
  .max(100);

/** The common runner protects full live tracker details; saved paths grant no I/O. */
export function projectBeadsRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<{ projectId: string; beadId?: string }> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/beads",
    operatorOnly: true,
    validate: (request) => {
      if (
        [...request.query.keys()].some(
          (key) => key !== "beadId" || request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported project bead query.");
      const beadId = request.query.get("beadId");
      if (beadId !== null && !isBeadId(beadId))
        return fail("Expected a bounded bead id.");
      const id = request.params["id"];
      return isProjectId(id)
        ? {
            ok: true,
            value: { projectId: id, ...(beadId !== null ? { beadId } : {}) },
          }
        : fail("Expected a project id.");
    },
    read: async ({ projectId: id, beadId }) => {
      try {
        const snapshot = await load(),
          project = snapshot.catalog.projects.find((item) => item.id === id);
        if (!project)
          return {
            status: 404,
            error: "This project is not in the hearth catalog.",
          };
        // First establish membership without touching history for an untrusted id.
        const data = projectBeads(project, snapshot.source, beadId);
        if (!beadId) return { status: 200, data };
        let events: ReturnType<typeof queryEventPage>["events"] | null = null,
          more = false,
          reservations: ReturnType<typeof activeReservations> | null = null;
        try {
          const page = queryEventPage(
            { workspace: deps.workspace, beadId, limit: 100 },
            hearthLedger(deps.ledgerPath),
          );
          events = page.events;
          more = page.more;
        } catch {
          /* Unavailable observations stay null. */
        }
        try {
          reservations = activeReservations(
            { workspace: deps.workspace },
            hearthLedger(deps.ledgerPath),
          );
        } catch {
          /* A failed reservation read is not an empty list. */
        }
        const detail = projectBeads(project, snapshot.source, beadId, {
          events,
          more,
          reservations,
        });
        const selected = detail.beads.find((bead) => bead.id === beadId);
        if (selected) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeoutMs = deps.bdTimeoutMs ?? 15_000;
            const answer = await Promise.race([
              Promise.resolve(
                deps.runBd(["--readonly", "comments", beadId, "--json"], {
                  timeoutMs,
                }),
              ),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(Error("Comment read deadline")),
                  timeoutMs,
                );
              }),
            ]);
            if (
              answer.status !== 0 ||
              new TextEncoder().encode(answer.stdout).byteLength > 524_288
            )
              throw Error("Comment read unavailable");
            let raw: unknown;
            try {
              raw = JSON.parse(answer.stdout);
            } catch {
              throw Error("Comment read is not JSON");
            }
            const comments = commentsSchema.safeParse(raw);
            if (
              !comments.success ||
              comments.data.some(
                (comment) =>
                  comment.issue_id !== undefined && comment.issue_id !== beadId,
              )
            )
              throw Error("Comment read could not be verified");
            selected.comments = comments.data.map((comment) => ({
              body: comment.text,
              author: comment.author,
              createdAt: comment.created_at,
            }));
            selected.commentsComplete = true;
          } catch {
            selected.commentsComplete = false;
            detail.problems.push(
              "The selected bead's live comment history is unavailable or exceeds its read limit. Embedded comments may be incomplete; refresh to check again.",
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        if (
          new TextEncoder().encode(JSON.stringify(detail)).byteLength >
          1_048_576
        )
          throw new ConversationError(
            503,
            "The selected bead details exceed their read limit. Check a smaller bead before refreshing.",
          );
        return { status: 200, data: projectBeadsPageSchema.parse(detail) };
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

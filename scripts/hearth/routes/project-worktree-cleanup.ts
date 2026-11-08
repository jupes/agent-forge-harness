import { createHash } from "node:crypto";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import {
  type CleanupRequest,
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../../projects/worktree-cleanup-protocol";
import {
  type CleanupServiceHost,
  createProjectWorktreeCleanupService,
} from "../../projects/worktree-cleanup-service";
import type { GitRun } from "../../scheduler/worktrees";
import type { ActionRoute, ReadRoute, RouteReply } from "../api";
import { fail } from "./operator-reads";

type Review = { projectId: string; request: CleanupRequest };
type Identity = { projectId: string; requestId: string; requestHash: string };
async function reply(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: cleanupReceiptSchema.parse(await work()) };
  } catch (error) {
    return error instanceof ProjectStoreError
      ? { status: error.status, error: error.message }
      : {
          status: 503,
          error:
            "Cleanup could not be verified. Read the saved original before any further action.",
        };
  }
}

/** The common runner owns origin, token, surface, body, audit and response envelope. */
export function createProjectWorktreeCleanupRoutes(
  options: CleanupServiceHost,
  controls: { git?: GitRun } = {},
) {
  const host = Object.freeze({
    home: options.home,
    root: options.root,
    queueLockFile: options.queueLockFile,
    ledgerPath: options.ledgerPath,
    runBd: options.runBd,
  });
  const git = controls.git;
  let service:
    | ReturnType<typeof createProjectWorktreeCleanupService>
    | undefined;
  const owner = () =>
    (service ??= createProjectWorktreeCleanupService(
      host,
      git === undefined ? {} : { git },
    ));
  const path = "/projects/:id/settings/worktree-cleanup";
  const cleanup: ActionRoute<Review> = {
    kind: "action",
    method: "POST",
    path,
    action: "project.worktree.cleanup",
    operatorOnly: true,
    rejectDuplicateBodyKeys: true,
    maxBodyBytes: 16384,
    validate: (input) => {
      const parsed = cleanupRequestSchema.safeParse(input.body);
      if (
        !isProjectId(input.params.id) ||
        input.query.size !== 0 ||
        !parsed.success
      )
        return fail(
          "Expected a project and only the complete reviewed cleanup request.",
        );
      return {
        ok: true,
        value: Object.freeze({
          projectId: input.params.id,
          request: Object.freeze({
            ...parsed.data,
            expectedRecord: Object.freeze({ ...parsed.data.expectedRecord }),
          }),
        }),
      };
    },
    subject: ({ projectId, request }) => ({
      target: projectId,
      beadId: request.expectedRecord.beadId,
      family: "project-worktree-cleanup",
      requestId: request.requestId,
      inputHash: createHash("sha256")
        .update(canonicalCleanupRequest(projectId, request))
        .digest("hex"),
    }),
    effect: ({ projectId, request }, context) =>
      reply(() => {
        if (!context)
          throw new ProjectStoreError(
            503,
            "The cleanup action has no recorded operator audit.",
          );
        return owner().cleanup(projectId, request, context);
      }),
  };
  const receipt: ReadRoute<Identity> = {
    kind: "read",
    method: "GET",
    path: path + "/:requestId",
    operatorOnly: true,
    validate: (input) => {
      const requestId = cleanupRequestSchema.shape.requestId.safeParse(
        input.params.requestId,
      );
      const hash = cleanupReceiptSchema.shape.requestHash.safeParse(
        input.query.get("requestHash"),
      );
      const keys = [...input.query.keys()];
      return isProjectId(input.params.id) &&
        requestId.success &&
        hash.success &&
        keys.length === 1 &&
        keys[0] === "requestHash"
        ? {
            ok: true,
            value: {
              projectId: input.params.id,
              requestId: requestId.data,
              requestHash: hash.data,
            },
          }
        : fail(
            "Expected the exact project, cleanup UUID and one original request hash.",
          );
    },
    read: ({ projectId, requestId, requestHash }) =>
      reply(() => owner().read(projectId, requestId, requestHash)),
  };
  return { cleanup, receipt };
}

import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveCheckout } from "../../ledger/workspace";
import { nativePhysicalPath } from "../../native-realpath";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import { readWorktreeCleanupPreflight } from "../../projects/worktree-cleanup-preflight";
import { cleanupRequestSchema } from "../../projects/worktree-cleanup-protocol";
import {
  type CleanupReview,
  cleanupReviewSchema,
} from "../../projects/worktree-cleanup-review-protocol";
import type { CleanupServiceHost } from "../../projects/worktree-cleanup-service";
import { type GitRun, registryPathKey } from "../../scheduler/worktrees";
import { readHomeFile } from "../home-guard";
import { projectSnapshotReader } from "./project-summaries";

type ReviewHost = Pick<
  CleanupServiceHost,
  "home" | "root" | "ledgerPath" | "runBd"
>;
/** Fresh advisory observations only; the audited owner retains all effect authority. */
export function createProjectWorktreeCleanupReviewReader(
  options: ReviewHost,
  controls: { git?: GitRun } = {},
) {
  const host = Object.freeze({
    home: options.home,
    root: options.root,
    ledgerPath: options.ledgerPath,
    runBd: options.runBd,
  });
  const git = controls.git;
  const capture = () => {
    const pins = [host.home, host.root].map((path) => {
      if (!isAbsolute(path)) throw Error("Nonabsolute review host");
      const info = lstatSync(path, { bigint: true });
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        registryPathKey(nativePhysicalPath(path)) !== registryPathKey(path)
      )
        throw Error("Noncanonical review host");
      return `${info.dev}:${info.ino}`;
    });
    const root = nativePhysicalPath(host.root);
    if (
      readHomeFile(host.home).problem !== null ||
      typeof host.runBd !== "function" ||
      !isAbsolute(host.ledgerPath) ||
      registryPathKey(host.ledgerPath) !==
        registryPathKey(join(host.home, "ledger.db")) ||
      registryPathKey(
        nativePhysicalPath(resolveCheckout(host.root).workspace),
      ) !== registryPathKey(root)
    )
      throw Error("Unverified review authority");
    return {
      root,
      pins: pins.join("|"),
      catalog: createProjectStore(host.home).read(),
    };
  };
  const member = (path: string, root: string) =>
    isAbsolute(path) &&
    registryPathKey(path) === registryPathKey(root) &&
    registryPathKey(nativePhysicalPath(path)) === registryPathKey(root);
  const active = (sample: ReturnType<typeof capture>, projectId: string) => {
    const project = sample.catalog.projects.find((row) => row.id === projectId);
    return (
      project !== undefined &&
      !project.archived &&
      project.workspaces.some(
        (scope) =>
          member(scope.root, sample.root) &&
          scope.repositories.some((path) => member(path, sample.root)),
      )
    );
  };
  return async (
    projectId: string,
    worktreeId: string,
  ): Promise<CleanupReview> => {
    if (
      !isProjectId(projectId) ||
      !cleanupRequestSchema.shape.expectedRecord.shape.id.safeParse(worktreeId)
        .success
    )
      throw new ProjectStoreError(
        400,
        "Expected an exact project and managed worktree id.",
      );
    const negative = (
      state: "refused" | "unknown",
      reason: string,
    ): CleanupReview =>
      cleanupReviewSchema.parse({
        projectId,
        worktreeId,
        asOf: new Date().toISOString(),
        removalAuthorized: false,
        state,
        reasons: [reason],
      });
    let initial: ReturnType<typeof capture>;
    try {
      initial = capture();
      if (!active(initial, projectId))
        return negative(
          "refused",
          "Current native project membership is missing or archived.",
        );
    } catch {
      throw new ProjectStoreError(
        503,
        "The protected cleanup review host or catalog is unavailable.",
      );
    }
    try {
      const load = projectSnapshotReader(
        host.home,
        {
          root: initial.root,
          workspace: initial.root,
          ledgerPath: host.ledgerPath,
          runBd: host.runBd,
        },
        { membershipOnly: true, includeEmpty: true, omitRuns: true },
      );
      const proof = await readWorktreeCleanupPreflight(
        {
          home: host.home,
          root: initial.root,
          projectId,
          worktreeId,
        },
        {
          ...(git === undefined ? {} : { git }),
          readSources: async () => (await load()).source,
        },
      );
      const fresh = capture();
      if (
        JSON.stringify(fresh) !== JSON.stringify(initial) ||
        !active(fresh, projectId)
      )
        return negative(
          "unknown",
          "Cleanup review observations changed while reading.",
        );
      if (proof.state !== "eligible")
        return cleanupReviewSchema.parse({
          projectId,
          worktreeId,
          asOf: new Date().toISOString(),
          removalAuthorized: false,
          state: proof.state,
          reasons: proof.reasons,
        });
      if (
        proof.catalogRevision !== initial.catalog.revision ||
        proof.record.id !== worktreeId ||
        !isAbsolute(proof.record.path) ||
        registryPathKey(proof.record.path) !==
          registryPathKey(join(initial.root, "trees", worktreeId))
      )
        return negative(
          "unknown",
          "The reviewed identity or catalog does not match the served managed target.",
        );
      return cleanupReviewSchema.parse({
        projectId,
        worktreeId,
        asOf: new Date().toISOString(),
        removalAuthorized: false,
        state: "eligible",
        reasons: [],
        repository: initial.root,
        expectedCatalogRevision: proof.catalogRevision,
        expectedRecord: proof.record,
        expectedHead: proof.head,
      });
    } catch {
      return negative(
        "unknown",
        "Cleanup review observations could not be completely verified.",
      );
    }
  };
}

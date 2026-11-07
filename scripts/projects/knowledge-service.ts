import type { ProjectRecord } from "../../types/projects";
import { loadConfig } from "../config/load";
import { ConversationError } from "../conversations/error";
import type { GitRun } from "../scheduler/worktrees";
import { withProjectAdmission } from "./admission";
import {
  createKnowledgeGenerator,
  type PreparedKnowledgeGenerator,
} from "./knowledge-generator";
import {
  buildKnowledgeYaml,
  type KnowledgeRefreshRequest,
  knowledgeReceiptSchema,
  knowledgeRefreshRequestSchema,
} from "./knowledge-protocol";
import {
  prepareKnowledgePublication,
  publishKnowledgeCandidate,
  withKnowledgePublicationLock,
} from "./knowledge-publication";
import {
  collectKnowledgeSource,
  type KnowledgeTarget,
  knowledgeDigest,
  knowledgeTargetSeal,
  readKnowledgeTarget,
  resolveKnowledgeTarget,
} from "./knowledge-source";
import {
  checkedKnowledgeOriginal,
  createKnowledgeStore,
  type KnowledgeOriginal,
  type KnowledgeRow,
  knowledgeOperationHash,
} from "./knowledge-store";
import { assertProjectCliCostAdmission } from "./project-budget-policy";
import { workspaceKey } from "./scope";
import { createProjectStore } from "./store";

interface Options {
  root: string;
  home: string;
  configHome?: string;
  operatorToken?: () => string | null;
  /** Trusted isolated seams, never accepted from API input. */
  git?: GitRun;
  generator?: Pick<
    ReturnType<typeof createKnowledgeGenerator>,
    "prepare" | "generate" | "revalidate"
  >;
  smithName?: (project: ProjectRecord) => string;
  publish?: typeof publishKnowledgeCandidate;
  now?: () => Date;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const pending = (row: KnowledgeRow) =>
  !["confirmed", "refused", "failed"].includes(row.receipt.state);
function conflict(message: string): never {
  throw new ConversationError(409, message);
}
export function createKnowledgeService(options: Options) {
  const store = createKnowledgeStore(options.home),
    projects = createProjectStore(options.home),
    now = options.now ?? (() => new Date());
  const generator =
    options.generator ??
    createKnowledgeGenerator({
      root: options.root,
      ...(options.configHome ? { configHome: options.configHome } : {}),
      operatorToken: options.operatorToken ?? (() => null),
    });
  const target = () => resolveKnowledgeTarget(options.root, options.git);
  const nameOf = (project: ProjectRecord) =>
    options.smithName?.(project) ??
    project.keeperSmith ??
    loadConfig({
      harnessRoot: options.root,
      env: {},
      ...(options.configHome ? { home: options.configHome } : {}),
    }).config.workflow.defaultCrew;
  const projectAt = (
    projectId: string,
    repository: KnowledgeTarget,
    revision?: number,
  ) => {
    const catalog = projects.read(),
      project = catalog.projects.find((row) => row.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is no longer in the catalog",
      );
    if (revision !== undefined && catalog.revision !== revision)
      conflict(
        "Project settings changed. Review them before a new knowledge operation.",
      );
    assertProjectCliCostAdmission(project);
    if (
      !project.workspaces.some(
        (workspace) =>
          workspaceKey(workspace.root) === workspaceKey(repository.root) &&
          workspace.repositories.some(
            (path) => workspaceKey(path) === workspaceKey(repository.root),
          ),
      )
    )
      conflict(
        "Knowledge refresh is available only for this project's already served repository. Other repository paths grant no read authority.",
      );
    return { catalog, project };
  };
  const membership = (project: ProjectRecord) =>
    knowledgeDigest(
      JSON.stringify({
        id: project.id,
        slug: project.slug,
        workspaces: project.workspaces
          .map((workspace) => ({
            root: workspaceKey(workspace.root),
            repositories: workspace.repositories.map(workspaceKey).sort(),
            epicIds: [...workspace.epicIds].sort(),
          }))
          .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)),
      }),
    );
  const requireOriginal = (projectId: string, requestId: string) => {
    const row = store.read(projectId, requestId);
    if (!row)
      throw new ConversationError(
        404,
        "No saved knowledge refresh original was found",
      );
    return row;
  };
  const verifySource = (
    repository: KnowledgeTarget,
    original: KnowledgeOriginal,
  ) => {
    if (
      repository.repositoryKey !== original.request.repositoryKey ||
      knowledgeTargetSeal(repository) !== original.authoritySeal
    )
      conflict("The original served repository authority changed");
    const source = collectKnowledgeSource(repository, options.git);
    if (
      source.sourceCommit !== original.sourceCommit ||
      source.evidenceHash !== original.evidenceHash
    )
      conflict(
        "The bounded source evidence changed; the saved candidate was retained without publication",
      );
    return source;
  };
  const verifyProject = (
    repository: KnowledgeTarget,
    original: KnowledgeOriginal,
  ) => {
    const { project } = projectAt(
      original.projectId,
      repository,
      original.request.expectedRevision,
    );
    if (
      membership(project) !== original.membershipHash ||
      nameOf(project) !== original.smith.name
    )
      conflict("The reviewed project membership or Knowledge Smith changed");
  };
  const publish = async (projectId: string, requestId: string) =>
    store.locked(async (state, save) => {
      const row = store.find(state, projectId, requestId);
      if (!row)
        throw new ConversationError(
          404,
          "No saved knowledge refresh original was found",
        );
      if (
        row.receipt.state === "confirmed" ||
        row.candidate === null ||
        !pending(row)
      )
        return row.receipt;
      try {
        const repository = target();
        if (
          knowledgeTargetSeal(repository) !== row.original.authoritySeal ||
          repository.repositoryKey !== row.original.request.repositoryKey
        )
          conflict("The original served repository authority changed");
        // Presence proves the requested bytes, not which process performed a rename.
        const current = readKnowledgeTarget(repository).snapshot;
        if (
          current.bytes === row.candidate &&
          current.hash === row.receipt.candidateHash
        ) {
          row.receipt.state = "confirmed";
          row.receipt.confirmedAt = now().toISOString();
          row.receipt.message =
            "The exact saved candidate bytes are present in the verified knowledge file.";
          save();
          return row.receipt;
        }
        const ready = await generator.prepare(row.original.smith.name);
        if (
          ready.profileHash !== row.original.profileHash ||
          !same(
            {
              name: ready.smith.name,
              provider: ready.smith.provider,
              model: ready.smith.model,
              effort: ready.smith.effort,
              enabled: ready.smith.enabled,
              tags: ready.smith.tags,
            },
            row.original.smith,
          )
        )
          conflict("The original knowledge generator profile changed");
        await withProjectAdmission(options.home, projectId, async () => {
          verifyProject(repository, row.original);
          await withKnowledgePublicationLock(repository, async () => {
            verifySource(repository, row.original);
            generator.revalidate(ready);
            const expected = row.publication ?? row.original.prior;
            const publication = prepareKnowledgePublication(
              repository,
              expected,
            );
            row.publication = publication;
            save(); // New fixed parent anchors precede the publication attempt.
            generator.revalidate(ready);
            row.publicationAttemptedAt ??= now().toISOString();
            row.receipt.state = "publishing";
            row.receipt.message =
              "The saved candidate publication was attempted. Check its original receipt if interrupted.";
            save();
            (options.publish ?? publishKnowledgeCandidate)(
              repository,
              publication,
              row.candidate ?? conflict("The saved candidate is unavailable"),
            );
            row.receipt.state = "confirmed";
            row.receipt.confirmedAt = now().toISOString();
            row.receipt.message =
              "The exact candidate was published and read back. Knowledge freshness comes from the verified file.";
            save();
          });
        });
      } catch {
        if (row.receipt.state === "confirmed")
          throw new ConversationError(
            503,
            "Knowledge publication confirmation could not be durably saved. Check the original receipt; do not repeat generation.",
          );
        if (row.receipt.state === "publishing") row.receipt.state = "unknown";
        row.receipt.message =
          row.receipt.state === "unknown"
            ? "Publication is unresolved. An explicit check may confirm only the exact saved candidate; no model will be run again."
            : "Publication was refused because its reviewed authority, source, generator or output could not be revalidated. The saved candidate was retained.";
        save();
      }
      return row.receipt;
    });
  return {
    receipt(projectId: string, requestId: string) {
      return requireOriginal(projectId, requestId).receipt;
    },
    status(projectId: string) {
      const repository = target(),
        catalog = projects.read(),
        project = catalog.projects.find((row) => row.id === projectId);
      if (!project) throw new ConversationError(404, "Project unavailable");
      if (
        !project.workspaces.some(
          (workspace) =>
            workspaceKey(workspace.root) === workspaceKey(repository.root) &&
            workspace.repositories.some(
              (path) => workspaceKey(path) === workspaceKey(repository.root),
            ),
        )
      )
        conflict(
          "The served repository is outside this project's configured workspace",
        );
      const value = readKnowledgeTarget(repository, now().getTime());
      return {
        projectId,
        catalogRevision: catalog.revision,
        repositoryKey: repository.repositoryKey,
        name: repository.name,
        state: value.state,
        ageDays: value.ageDays,
        freshness: value.freshness,
        asOf: now().toISOString(),
        archived: project.archived,
      };
    },
    publish,
    async retire(projectId: string, requestId: string) {
      return store.locked(async (state, save) => {
        const row = store.find(state, projectId, requestId);
        if (!row)
          throw new ConversationError(
            404,
            "No saved knowledge refresh original was found",
          );
        if (row.receipt.state === "failed") return row.receipt;
        if (
          row.receipt.state !== "candidate-saved" ||
          row.publicationAttemptedAt !== null
        )
          conflict(
            "Only a saved candidate with no publication attempt may be retired. Unresolved generation or publication must remain held.",
          );
        row.receipt.state = "failed";
        row.receipt.message =
          "The never-published candidate was explicitly retired. The prior repository file was retained.";
        save();
        return row.receipt;
      });
    },
    async refresh(projectId: string, input: KnowledgeRefreshRequest) {
      const request = knowledgeRefreshRequestSchema.parse(input),
        requestHash = knowledgeOperationHash(projectId, request),
        previous = store.read(projectId, request.requestId);
      if (previous) {
        if (previous.original.requestHash !== requestHash)
          conflict("This knowledge UUID belongs to another immutable original");
        return previous.receipt;
      }
      const repository = target();
      if (request.repositoryKey !== repository.repositoryKey)
        conflict(
          "The selected repository is not this host's served repository",
        );
      const { project } = projectAt(
          projectId,
          repository,
          request.expectedRevision,
        ),
        prior = readKnowledgeTarget(repository),
        source = collectKnowledgeSource(repository, options.git),
        ready: PreparedKnowledgeGenerator = await generator.prepare(
          nameOf(project),
        );
      const original = checkedKnowledgeOriginal({
        projectId,
        request,
        requestHash,
        authoritySeal: knowledgeTargetSeal(repository),
        name: repository.name,
        membershipHash: membership(project),
        smith: ready.smith,
        profileHash: ready.profileHash,
        sourceCommit: source.sourceCommit,
        evidenceHash: source.evidenceHash,
        prior: prior.snapshot,
        createdAt: now().toISOString(),
      });
      const admitted = await store.locked(async (state, save) => {
        const existing = store.find(state, projectId, request.requestId);
        if (existing) {
          if (existing.original.requestHash !== requestHash)
            conflict(
              "This knowledge UUID belongs to another immutable original",
            );
          return false;
        }
        if (
          state.records.some(
            (row) =>
              pending(row) &&
              row.original.request.repositoryKey === request.repositoryKey,
          )
        )
          conflict(
            "A knowledge refresh is already unresolved for this served repository. Check its saved original.",
          );
        return withProjectAdmission(options.home, projectId, async () => {
          verifyProject(repository, original);
          verifySource(repository, original);
          if (!same(readKnowledgeTarget(repository).snapshot, original.prior))
            conflict("Knowledge output changed before generation admission");
          const row: KnowledgeRow = {
            original,
            sealHash: knowledgeDigest(JSON.stringify(original)),
            candidate: null,
            publication: null,
            attemptedAt: null,
            candidateSavedAt: null,
            publicationAttemptedAt: null,
            receipt: knowledgeReceiptSchema.parse({
              projectId,
              requestId: request.requestId,
              requestHash,
              repositoryKey: request.repositoryKey,
              state: "reserved",
              sourceCommit: source.sourceCommit,
              evidenceHash: source.evidenceHash,
              candidateHash: null,
              confirmedAt: null,
              message:
                "Knowledge generation was reserved. Exact recovery never reruns the model.",
              retainedExtensions: [],
            }),
          };
          state.records.push(row);
          save();
          row.attemptedAt = now().toISOString();
          row.receipt.state = "attempted";
          row.receipt.message =
            "Knowledge generation was attempted. An interrupted result remains unresolved without automatic dispatch.";
          save();
          return true;
        });
      });
      if (!admitted)
        return requireOriginal(projectId, request.requestId).receipt;
      try {
        const generated = await generator.generate(ready, source),
          candidate = buildKnowledgeYaml({
            generated,
            prior: prior.prior,
            name: repository.name,
            sourceCommit: source.sourceCommit,
            evidenceHash: source.evidenceHash,
            generatedAt: now().toISOString(),
          });
        await store.locked(async (state, save) => {
          const row = store.find(state, projectId, request.requestId);
          if (
            !row ||
            row.receipt.state !== "attempted" ||
            row.original.requestHash !== requestHash
          )
            conflict("The saved knowledge generation owner changed");
          row.candidate = candidate.text;
          row.candidateSavedAt = now().toISOString();
          row.receipt.candidateHash = knowledgeDigest(candidate.text);
          row.receipt.retainedExtensions = candidate.retainedExtensions;
          row.receipt.state = "candidate-saved";
          row.receipt.message =
            "The complete candidate was saved before any repository output effect.";
          save();
        });
      } catch {
        return store.locked(async (state, save) => {
          const row = store.find(state, projectId, request.requestId);
          if (!row)
            throw new ConversationError(
              503,
              "Knowledge original unavailable; no generation retry is allowed",
            );
          if (row.receipt.state === "attempted") {
            row.receipt.state = "unknown";
            row.receipt.message =
              "Generation or candidate persistence could not be confirmed. No repository output was authorized, and the model will not be run again for this original.";
            save();
          }
          return row.receipt;
        });
      }
      return publish(projectId, request.requestId);
    },
  };
}

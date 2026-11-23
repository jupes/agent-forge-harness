/** Trusted preview/edit coordinator; routes and request authority live above it. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  SmithConfigEditPreview,
  SmithConfigEditPreviewRequest,
  SmithConfigEditReceipt,
} from "../../types/smith-config-edit";
import { agentForgeHome } from "../agent-forge-home";
import { type LoadOptions, machineConfigFile } from "./load";
import { createSmithConfigJournalStorage } from "./smith-config-journal-storage";
import type { SmithCreateJournalStorage } from "./smith-create-journal-core";
import { canonicalSmithCreateDirectory } from "./smith-create-trusted-directory";
import {
  createSmithEditJournalCore,
  SmithEditJournalError,
} from "./smith-edit-journal-core";
import type { SmithEditOwner } from "./smith-edit-journal-protocol";
import {
  SMITH_CONFIG_EDIT_LIMITS,
  smithConfigEditPreviewRequestSchema,
  smithConfigEditPreviewSchema,
  smithConfigEditRequestSchema,
} from "./smith-edit-protocol";
import {
  type ConfigPairedRevision,
  type ConfigWriteTransaction,
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";
import { ConfigTransactionError } from "./transaction-error";
import {
  buildSmithEditCandidate,
  type SmithEditCandidateOutcome,
} from "./write";

type ReadSources = typeof readConfigTransactionSources;
type RunTransaction = typeof withConfigTransaction;
type BuildCandidate = typeof buildSmithEditCandidate;

export interface SmithEditServiceControls {
  /** Trusted internal test seam; never selected by an operator request. */
  profileHome?: string;
  coordinationRoot?: string;
  storage?: SmithCreateJournalStorage;
  readSources?: ReadSources;
  withTransaction?: RunTransaction;
  buildCandidate?: BuildCandidate;
  now?: () => string;
}

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = Object.freeze(
  {},
);
const canonical = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const hashRevision = (revision: ConfigPairedRevision["user"]) =>
  createHash("sha256").update(JSON.stringify(revision), "utf8").digest("hex");
const revisionTokens = (revision: ConfigPairedRevision) => ({
  version: 1 as const,
  user: hashRevision(revision.user),
  workspace: hashRevision(revision.workspace),
});

function canonicalDirectory(path: string, label: string) {
  const real = canonicalSmithCreateDirectory(path),
    info = lstatSync(real, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The trusted Smith edit ${label} is not canonical.`);
  return { path: real, dev: String(info.dev), ino: String(info.ino) };
}

function refusalFor(error: unknown) {
  if (error instanceof ConfigTransactionError) {
    if (error.reason === "changed") return "stale-revision" as const;
    if (error.reason === "closed") return "cancelled-before-attempt" as const;
    if (error.reason === "busy" || error.reason === "unusable")
      return "write-refused-before-attempt" as const;
  }
  return "source-unavailable" as const;
}

function previewFrom(
  request: SmithConfigEditPreviewRequest,
  file: string,
  revision: ConfigPairedRevision,
  candidate: Exclude<SmithEditCandidateOutcome, { ok: false }>["value"],
): SmithConfigEditPreview {
  return smithConfigEditPreviewSchema.parse({
    version: 1,
    target: request.target,
    file,
    expectedRevision: revisionTokens(revision),
    candidate: {
      sha256: candidate.sha256,
      byteLength: candidate.bytes.byteLength,
      created: candidate.created,
    },
    review: candidate.review,
  });
}

/** Prepare trusted selectors synchronously; this does not read or create config files. */
export function createSmithEditService(
  input: { options: LoadOptions },
  controls: SmithEditServiceControls = {},
) {
  const checkout = canonicalDirectory(input.options.harnessRoot, "checkout"),
    profile = canonicalSmithCreateDirectory(
      controls.profileHome ?? agentForgeHome(),
    ),
    options = Object.freeze({
      ...input.options,
      harnessRoot: checkout.path,
      env: EMPTY_ENV,
    }),
    fileSelectors = Object.freeze({
      user: resolve(machineConfigFile(options)),
      workspace: resolve(join(checkout.path, "agent-forge.toml")),
    }),
    coordinationRoot = resolve(
      controls.coordinationRoot ??
        join(homedir(), ".agent-forge-config-transactions"),
    ),
    prepare = (target: "user" | "workspace") =>
      prepareConfigTransaction({
        options,
        target,
        maxSourceBytes: SMITH_CONFIG_EDIT_LIMITS.sourceBytes,
        coordinationRoot,
        fileSelectors,
      }),
    owner: SmithEditOwner = Object.freeze({
      version: 1,
      checkout: {
        path: checkout.path,
        dev: checkout.dev,
        ino: checkout.ino,
      },
      profile,
      userSelector: canonical(fileSelectors.user),
      workspaceSelector: canonical(fileSelectors.workspace),
    }),
    storage =
      controls.storage ?? createSmithConfigJournalStorage(profile, "edit"),
    journal = createSmithEditJournalCore(storage, owner, controls.now),
    readSources = controls.readSources ?? readConfigTransactionSources,
    runTransaction = controls.withTransaction ?? withConfigTransaction,
    makeCandidate = controls.buildCandidate ?? buildSmithEditCandidate;

  const snapshotCandidate = (
    request: SmithConfigEditPreviewRequest,
    revision: ConfigPairedRevision,
    sources: ReturnType<ReadSources>["sources"],
  ) => {
    const outcome = makeCandidate(request, sources, EMPTY_ENV);
    if (!outcome.ok) throw new Error(outcome.error);
    const candidate = outcome.value,
      digest = createHash("sha256").update(candidate.bytes).digest("hex");
    if (
      candidate.bytes.byteLength > SMITH_CONFIG_EDIT_LIMITS.sourceBytes ||
      candidate.sha256 !== digest
    )
      throw new Error("The Smith edit candidate is invalid or too large.");
    return previewFrom(request, candidate.file, revision, candidate);
  };

  const preview = (value: unknown): SmithConfigEditPreview => {
    const checked = smithConfigEditPreviewRequestSchema.safeParse(value);
    if (!checked.success)
      throw new Error("Invalid Smith edit preview request.");
    const found = readSources(prepare(checked.data.target));
    return snapshotCandidate(checked.data, found.revision, found.sources);
  };

  const edit = async (value: unknown): Promise<SmithConfigEditReceipt> => {
    const checked = smithConfigEditRequestSchema.safeParse(value);
    if (!checked.success) throw new Error("Invalid Smith edit request.");
    const request = checked.data,
      requestPreview: SmithConfigEditPreviewRequest = {
        target: request.target,
        name: request.name,
        smith: request.smith,
      };
    try {
      return await journal.reserve(request, async (writer) => {
        let attemptedMarkerBegan = false;
        try {
          const context = prepare(request.target);
          await runTransaction(
            context,
            (transaction: ConfigWriteTransaction) => {
              if (
                JSON.stringify(revisionTokens(transaction.revision)) !==
                JSON.stringify(request.expectedRevision)
              ) {
                writer.refuse("stale-revision");
                return;
              }
              const outcome = makeCandidate(
                requestPreview,
                transaction.sources,
                EMPTY_ENV,
              );
              if (!outcome.ok) {
                writer.refuse("invalid-candidate");
                return;
              }
              const candidate = outcome.value,
                digest = createHash("sha256")
                  .update(candidate.bytes)
                  .digest("hex");
              if (
                candidate.bytes.byteLength >
                  SMITH_CONFIG_EDIT_LIMITS.sourceBytes ||
                candidate.sha256 !== digest
              ) {
                writer.refuse("invalid-candidate");
                return;
              }
              const reviewed = previewFrom(
                requestPreview,
                candidate.file,
                transaction.revision,
                candidate,
              );
              writer.prepare(reviewed);
              attemptedMarkerBegan = true;
              writer.attempted();
              const publication = transaction.publish(candidate.bytes);
              writer.confirm(publication);
            },
          );
        } catch (error) {
          if (attemptedMarkerBegan) throw error;
          writer.refuse(refusalFor(error));
        }
      });
    } catch (error) {
      if (!(error instanceof SmithEditJournalError) || error.reason !== "held")
        throw error;
      try {
        const historical = journal.readOriginal(request.requestId);
        if (historical !== null) return historical;
      } catch {
        // Corrupt and uncertain histories remain held; never reconstruct or replay.
      }
      throw error;
    }
  };

  return Object.freeze({ preview, edit, readOriginal: journal.readOriginal });
}

/** Trusted preview/create coordinator; routes and request authority live above it. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  SmithConfigCreateReceipt,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
} from "../../types/smith-config-create";
import { agentForgeHome } from "../agent-forge-home";
import { type LoadOptions, machineConfigFile } from "./load";
import {
  createSmithCreateJournalCore,
  SmithCreateJournalError,
  type SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import type { SmithCreateOwner } from "./smith-create-journal-protocol";
import { createSmithCreateJournalStorage } from "./smith-create-journal-storage";
import {
  SMITH_CONFIG_CREATE_LIMITS,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
} from "./smith-create-protocol";
import {
  type ConfigPairedRevision,
  type ConfigWriteTransaction,
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";
import { ConfigTransactionError } from "./transaction-error";
import { configAddress } from "./transaction-paths";
import {
  buildSmithCreateCandidate,
  type SmithCreateCandidateOutcome,
} from "./write";

type ReadSources = typeof readConfigTransactionSources;
type RunTransaction = typeof withConfigTransaction;
type BuildCandidate = typeof buildSmithCreateCandidate;

export interface SmithCreateServiceControls {
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
  const requested = resolve(path),
    real = realpathSync.native(requested),
    info = lstatSync(real, { bigint: true });
  if (
    canonical(requested) !== canonical(real) ||
    !info.isDirectory() ||
    info.isSymbolicLink()
  )
    throw new Error(`The trusted Smith create ${label} is not canonical.`);
  return {
    path: real,
    dev: String(info.dev),
    ino: String(info.ino),
  };
}

function canonicalProfile(path: string): string {
  const requested = resolve(path),
    anchorFile = configAddress(
      join(requested, ".smith-create-profile-anchor"),
    ).file,
    physical = dirname(anchorFile);
  if (canonical(requested) !== canonical(physical))
    throw new Error("The trusted Smith create profile is not canonical.");
  return physical;
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
  request: SmithConfigPreviewRequest,
  file: string,
  revision: ConfigPairedRevision,
  candidate: Exclude<SmithCreateCandidateOutcome, { ok: false }>["value"],
): SmithConfigPreview {
  const fields = ["provider", "model", "effort", "enabled", "tags"] as const;
  return smithConfigPreviewSchema.parse({
    version: 1,
    target: request.target,
    file,
    expectedRevision: revisionTokens(revision),
    candidate: {
      sha256: candidate.sha256,
      byteLength: candidate.bytes.byteLength,
      created: candidate.created,
    },
    review: {
      before: null,
      after: candidate.smith,
      provenance: Object.fromEntries(
        fields.map((field) => [
          field,
          candidate.effective.provenance[
            `smiths.${request.smith.name}.${field}`
          ]?.source,
        ]),
      ),
    },
  });
}

/** Prepare trusted selectors synchronously; no config bytes or directories are read/created here. */
export function createSmithCreateService(
  input: { options: LoadOptions },
  controls: SmithCreateServiceControls = {},
) {
  const checkout = canonicalDirectory(input.options.harnessRoot, "checkout"),
    profile = canonicalProfile(controls.profileHome ?? agentForgeHome()),
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
        maxSourceBytes: SMITH_CONFIG_CREATE_LIMITS.sourceBytes,
        coordinationRoot,
        fileSelectors,
      }),
    owner: SmithCreateOwner = Object.freeze({
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
    storage = controls.storage ?? createSmithCreateJournalStorage(profile),
    journal = createSmithCreateJournalCore(storage, owner, controls.now),
    readSources = controls.readSources ?? readConfigTransactionSources,
    runTransaction = controls.withTransaction ?? withConfigTransaction,
    makeCandidate = controls.buildCandidate ?? buildSmithCreateCandidate;

  const snapshotCandidate = (
    request: SmithConfigPreviewRequest,
    revision: ConfigPairedRevision,
    sources: ReturnType<ReadSources>["sources"],
  ) => {
    const outcome = makeCandidate({
      target: request.target,
      smith: request.smith,
      sources,
      env: EMPTY_ENV,
    });
    if (!outcome.ok) throw new Error(outcome.error);
    const candidate = outcome.value,
      digest = createHash("sha256").update(candidate.bytes).digest("hex");
    if (
      candidate.bytes.byteLength > SMITH_CONFIG_CREATE_LIMITS.sourceBytes ||
      candidate.sha256 !== digest
    )
      throw new Error("The Smith create candidate is invalid or too large.");
    return previewFrom(request, candidate.file, revision, candidate);
  };

  const preview = (value: unknown): SmithConfigPreview => {
    const checked = smithConfigPreviewRequestSchema.safeParse(value);
    if (!checked.success)
      throw new Error("Invalid Smith create preview request.");
    const found = readSources(prepare(checked.data.target));
    return snapshotCandidate(checked.data, found.revision, found.sources);
  };

  const create = async (value: unknown): Promise<SmithConfigCreateReceipt> => {
    const checked = smithConfigCreateRequestSchema.safeParse(value);
    if (!checked.success) throw new Error("Invalid Smith create request.");
    const request = checked.data,
      requestPreview = {
        target: request.target,
        smith: request.smith,
      } as const;
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
              const outcome = makeCandidate({
                target: request.target,
                smith: request.smith,
                sources: transaction.sources,
                env: EMPTY_ENV,
              });
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
                  SMITH_CONFIG_CREATE_LIMITS.sourceBytes ||
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
      if (
        !(error instanceof SmithCreateJournalError) ||
        error.reason !== "held"
      )
        throw error;
      try {
        const historical = journal.readOriginal(request.requestId);
        if (historical !== null) return historical;
      } catch {
        // A corrupt or uncertain chain stays held; it is never reconstructed.
      }
      throw error;
    }
  };

  return Object.freeze({
    preview,
    create,
    readOriginal: journal.readOriginal,
  });
}

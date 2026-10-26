/** Trusted routing-edit coordinator; route authority and audit stay above it. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditReceipt,
} from "../../types/smith-routing-edit";
import { agentForgeHome } from "../agent-forge-home";
import { type LoadOptions, machineConfigFile } from "./load";
import { createSmithConfigJournalStorage } from "./smith-config-journal-storage";
import type { SmithCreateJournalStorage } from "./smith-create-journal-core";
import { canonicalSmithCreateDirectory } from "./smith-create-trusted-directory";
import {
  createSmithRoutingEditJournalCore,
  SmithRoutingEditJournalError,
} from "./smith-routing-edit-journal-core";
import type { SmithRoutingEditJournalOwner } from "./smith-routing-edit-journal-protocol";
import {
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditPreviewRequestSchema,
  smithRoutingEditPreviewSchema,
  smithRoutingEditRequestSchema,
  smithRoutingEditSuccessEnvelopeWithin,
} from "./smith-routing-edit-protocol";
import {
  type ConfigPairedRevision,
  type ConfigWriteTransaction,
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";
import { ConfigTransactionError } from "./transaction-error";
import {
  buildSmithRoutingEditCandidate,
  type SmithRoutingEditCandidateOutcome,
} from "./write";

type ReadSources = typeof readConfigTransactionSources;
type RunTransaction = typeof withConfigTransaction;
type BuildCandidate = typeof buildSmithRoutingEditCandidate;

export interface SmithRoutingEditServiceControls {
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

class PreviewTooLarge extends Error {}

function canonicalDirectory(path: string, label: string) {
  const real = canonicalSmithCreateDirectory(path),
    info = lstatSync(real, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The trusted routing edit ${label} is not canonical.`);
  return { path: real, dev: String(info.dev), ino: String(info.ino) };
}

function candidateRefusal(error: string) {
  if (
    error.includes("shadowed") ||
    error.includes("would not make the requested value effective")
  )
    return "shadowed-target" as const;
  if (error.includes("response limit"))
    return "success-preview-too-large" as const;
  return "invalid-current-config" as const;
}

function transactionRefusal(error: unknown) {
  if (error instanceof ConfigTransactionError) {
    if (error.reason === "changed") return "stale-revision" as const;
    return "write-refused-before-attempt" as const;
  }
  return "invalid-current-config" as const;
}

function previewFrom(
  request: SmithRoutingEditPreviewRequest,
  revision: ConfigPairedRevision,
  candidate: Exclude<SmithRoutingEditCandidateOutcome, { ok: false }>["value"],
): SmithRoutingEditPreview {
  const value = {
    version: 1 as const,
    target: request.target,
    file: candidate.file,
    expectedRevision: revisionTokens(revision),
    candidate: {
      sha256: candidate.sha256,
      byteLength: candidate.bytes.byteLength,
      created: candidate.created,
    },
    review: candidate.review,
  };
  if (!smithRoutingEditSuccessEnvelopeWithin(value))
    throw new PreviewTooLarge();
  const checked = smithRoutingEditPreviewSchema.safeParse(value);
  if (!checked.success) throw new Error("The routing preview is invalid.");
  return checked.data;
}

/** Prepare trusted selectors synchronously; this does not read or create config files. */
export function createSmithRoutingEditService(
  input: { options: LoadOptions },
  controls: SmithRoutingEditServiceControls = {},
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
        maxSourceBytes: SMITH_ROUTING_EDIT_LIMITS.sourceBytes,
        coordinationRoot,
        fileSelectors,
      }),
    owner: SmithRoutingEditJournalOwner = Object.freeze({
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
      controls.storage ?? createSmithConfigJournalStorage(profile, "routing"),
    journal = createSmithRoutingEditJournalCore(storage, owner, controls.now),
    readSources = controls.readSources ?? readConfigTransactionSources,
    runTransaction = controls.withTransaction ?? withConfigTransaction,
    makeCandidate = controls.buildCandidate ?? buildSmithRoutingEditCandidate;

  const snapshotCandidate = (
    request: SmithRoutingEditPreviewRequest,
    revision: ConfigPairedRevision,
    sources: ReturnType<ReadSources>["sources"],
  ) => {
    const outcome = makeCandidate(request, sources);
    if (!outcome.ok) {
      if (candidateRefusal(outcome.error) === "success-preview-too-large")
        throw new PreviewTooLarge();
      throw new Error(outcome.error);
    }
    const candidate = outcome.value,
      digest = createHash("sha256").update(candidate.bytes).digest("hex");
    if (
      candidate.bytes.byteLength > SMITH_ROUTING_EDIT_LIMITS.sourceBytes ||
      candidate.sha256 !== digest
    )
      throw new Error("The routing edit candidate is invalid or too large.");
    return previewFrom(request, revision, candidate);
  };

  const preview = (value: unknown): SmithRoutingEditPreview => {
    const checked = smithRoutingEditPreviewRequestSchema.safeParse(value);
    if (!checked.success)
      throw new Error("Invalid routing edit preview request.");
    const found = readSources(prepare(checked.data.target));
    return snapshotCandidate(checked.data, found.revision, found.sources);
  };

  const edit = async (value: unknown): Promise<SmithRoutingEditReceipt> => {
    const checked = smithRoutingEditRequestSchema.safeParse(value);
    if (!checked.success) throw new Error("Invalid routing edit request.");
    const request = checked.data,
      requestPreview: SmithRoutingEditPreviewRequest = {
        target: request.target,
        change: request.change,
      };
    return journal.reserve(request, async (writer) => {
      let attemptedMarkerBegan = false;
      try {
        const context = prepare(request.target);
        await runTransaction(context, (transaction: ConfigWriteTransaction) => {
          if (
            JSON.stringify(revisionTokens(transaction.revision)) !==
            JSON.stringify(request.expectedRevision)
          ) {
            writer.refuse("stale-revision");
            return;
          }
          const outcome = makeCandidate(requestPreview, transaction.sources);
          if (!outcome.ok) {
            writer.refuse(candidateRefusal(outcome.error));
            return;
          }
          const candidate = outcome.value,
            digest = createHash("sha256").update(candidate.bytes).digest("hex");
          if (
            candidate.bytes.byteLength >
              SMITH_ROUTING_EDIT_LIMITS.sourceBytes ||
            candidate.sha256 !== digest
          ) {
            writer.refuse("invalid-current-config");
            return;
          }
          let reviewed: SmithRoutingEditPreview;
          try {
            reviewed = previewFrom(
              requestPreview,
              transaction.revision,
              candidate,
            );
          } catch (error) {
            if (error instanceof PreviewTooLarge) {
              writer.refuse("success-preview-too-large");
              return;
            }
            throw error;
          }
          if (!writer.prepare(reviewed)) return;
          attemptedMarkerBegan = true;
          writer.attempted();
          const publication = transaction.publish(candidate.bytes);
          writer.confirm(publication);
        });
      } catch (error) {
        if (attemptedMarkerBegan) {
          try {
            writer.unconfirmed();
          } catch {
            // Durable attempted evidence alone keeps this original held.
          }
          return;
        }
        writer.refuse(transactionRefusal(error));
      }
    });
  };

  return Object.freeze({ preview, edit, readOriginal: journal.readOriginal });
}

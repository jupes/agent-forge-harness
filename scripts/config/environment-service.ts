import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { BASE_ENV_ALLOWLIST } from "./defaults";
import {
  ENVIRONMENT_LIMITS,
  type EnvironmentRecord,
  type EnvironmentStatus,
  environmentNamesSchema,
  environmentRecordSchema,
  environmentRequestSchema,
  environmentStatusSchema,
} from "./environment-protocol";
import {
  type LoadOptions,
  loadConfigFromByteContents,
  machineConfigFile,
} from "./load";
import {
  type ConfigPairedRevision,
  type ConfigWriteTransaction,
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";
import { ConfigTransactionError } from "./transaction-error";
import { buildExecutionEnvCandidate, type ConfigTarget } from "./write";

export class EnvironmentSettingsError extends Error {
  constructor(
    readonly status: 400 | 409 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () =>
  new EnvironmentSettingsError(
    503,
    "Environment configuration or its private history could not be verified. No configuration change was started by this request.",
  );
const stale = () =>
  new EnvironmentSettingsError(
    409,
    "The reviewed configuration changed. Check environment settings before reviewing another save.",
  );
const unknown = () =>
  new EnvironmentSettingsError(
    504,
    "The environment save outcome is unknown. Check its exact receipt; do not repeat the request.",
  );
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revisionTokens = (revision: ConfigPairedRevision) => ({
  user: hash(revision.user),
  workspace: hash(revision.workspace),
});
const same = (left: unknown, right: unknown) =>
  Bun.deepEquals(left, right, true);
const MARKER = "execution-environment-v1\n";

/** Trusted host selectors only; never accepts a public path or environment value. */
export function createEnvironmentSettingsService(input: {
  options: LoadOptions;
  /** Trusted scratch seams, never operator input. */
  coordinationRoot?: string;
  write?: typeof writeOwnerOnly;
  withTransaction?: typeof withConfigTransaction;
  now?: () => Date;
}) {
  const root = realpathSync.native(input.options.harnessRoot),
    rootInfo = lstatSync(root, { bigint: true }),
    options = Object.freeze({
      ...input.options,
      harnessRoot: root,
      env: Object.freeze({}),
    }),
    fileSelectors = Object.freeze({
      user: resolve(machineConfigFile(options)),
      workspace: join(root, "agent-forge.toml"),
    }),
    coordinationRoot = resolve(
      input.coordinationRoot ??
        join(homedir(), ".agent-forge-config-transactions"),
    ),
    journalHome = join(coordinationRoot, "environment-v1"),
    now = input.now ?? (() => new Date()),
    abort = new AbortController(),
    operations = new Set<Promise<void>>();
  let closed = false,
    held = false;
  function prepare(target: ConfigTarget = "user") {
    const current = lstatSync(root, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== rootInfo.dev ||
      current.ino !== rootInfo.ino
    )
      throw unavailable();
    return prepareConfigTransaction({
      options,
      target,
      fileSelectors,
      coordinationRoot,
      maxSourceBytes: ENVIRONMENT_LIMITS.sourceBytes,
    });
  }
  function readRecord(): EnvironmentRecord {
    try {
      const stored = readHomeFileBounded(
          journalHome,
          join(journalHome, "latest.json"),
          ENVIRONMENT_LIMITS.recordBytes,
        ),
        marker = readHomeFileBounded(
          journalHome,
          join(journalHome, "initialized"),
          64,
        );
      if (stored.problem || marker.problem) throw unavailable();
      if (stored.text === null && marker.text === null)
        return { version: 1, revision: 0, last: null };
      if (stored.text === null || marker.text !== MARKER) throw unavailable();
      const record = environmentRecordSchema.parse(JSON.parse(stored.text));
      if (record.revision === 0) throw unavailable();
      return record;
    } catch {
      throw unavailable();
    }
  }
  function publish(record: EnvironmentRecord) {
    const checked = environmentRecordSchema.parse(record);
    (input.write ?? writeOwnerOnly)(
      join(journalHome, "latest.json"),
      JSON.stringify(checked),
    );
    if (!same(readRecord(), checked)) throw unknown();
  }
  function snapshot(
    transaction: Pick<ConfigWriteTransaction, "sources" | "revision">,
    record: EnvironmentRecord,
  ): EnvironmentStatus {
    const sources = transaction.sources,
      target: ConfigTarget =
        sources.workspace.bytes === null ? "user" : "workspace",
      loaded = loadConfigFromByteContents({ sources, env: {} }),
      names = environmentNamesSchema.parse(loaded.config.execution.envPass),
      file = sources[target].file,
      normalized = (path: string) =>
        process.platform === "win32" ? path.toLowerCase() : path,
      ownerKey = hash({
        root: normalized(root),
        dev: String(rootInfo.dev),
        ino: String(rootInfo.ino),
        user: normalized(sources.user.file),
        workspace: normalized(sources.workspace.file),
      });
    return environmentStatusSchema.parse({
      version: 1,
      ownerKey,
      target,
      file,
      names,
      baseNames: [...BASE_ENV_ALLOWLIST],
      provenance: loaded.provenance["execution.env.pass"]?.source,
      revision: revisionTokens(transaction.revision),
      record,
      checkedAt: now().toISOString(),
      canSave:
        !closed &&
        !held &&
        record.last?.state !== "pending" &&
        record.revision < Number.MAX_SAFE_INTEGER &&
        buildExecutionEnvCandidate({ target, names }, sources).ok,
    });
  }
  function read(): EnvironmentStatus {
    if (closed) throw unavailable();
    try {
      return snapshot(readConfigTransactionSources(prepare()), readRecord());
    } catch {
      throw unavailable();
    }
  }
  return {
    read,
    async save(raw: unknown): Promise<EnvironmentStatus> {
      let finish = () => {};
      const operation = new Promise<void>((done) => {
        finish = done;
      });
      operations.add(operation);
      let intentAttempted = false;
      try {
        const parsed = environmentRequestSchema.safeParse(raw);
        if (!parsed.success)
          throw new EnvironmentSettingsError(
            400,
            "Enter only unique environment variable names and a fresh reviewed revision.",
          );
        if (closed) throw unavailable();
        if (held) throw unknown();
        const request = parsed.data,
          initial = read();
        if (
          request.ownerKey !== initial.ownerKey ||
          !same(request.expectedRevision, initial.revision) ||
          request.expectedJournalRevision !== initial.record.revision
        )
          throw stale();
        return await (input.withTransaction ?? withConfigTransaction)(
          prepare(initial.target),
          (transaction) => {
            if (closed || abort.signal.aborted) throw unavailable();
            const record = readRecord(),
              current = snapshot(transaction, record);
            if (record.last?.state === "pending" || held) throw unknown();
            if (
              current.target !== initial.target ||
              request.ownerKey !== current.ownerKey ||
              !same(request.expectedRevision, current.revision) ||
              request.expectedJournalRevision !== record.revision ||
              record.last?.request.requestId === request.requestId
            )
              throw stale();
            if (!current.canSave) throw unavailable();
            const candidate = buildExecutionEnvCandidate(
              { target: current.target, names: request.names },
              transaction.sources,
            );
            if (
              !candidate.ok ||
              candidate.value.bytes.byteLength > ENVIRONMENT_LIMITS.sourceBytes
            )
              throw new EnvironmentSettingsError(
                400,
                "This configuration cannot be edited safely. Review the names and configuration file manually.",
              );
            const pending: EnvironmentRecord = {
              version: 1,
              revision: record.revision + 1,
              last: {
                request,
                candidateHash: candidate.value.sha256,
                startedAt: now().toISOString(),
                finishedAt: null,
                state: "pending",
              },
            };
            ensurePrivateHome(journalHome);
            intentAttempted = true;
            (input.write ?? writeOwnerOnly)(
              join(journalHome, "initialized"),
              MARKER,
            );
            publish(pending);
            if (closed || abort.signal.aborted) throw unknown();
            const publication = transaction.publish(candidate.value.bytes);
            if (
              publication.sha256 !== candidate.value.sha256 ||
              publication.file !== current.file ||
              !pending.last
            )
              throw unknown();
            const completed: EnvironmentRecord = {
              ...pending,
              last: {
                ...pending.last,
                state: "completed",
                finishedAt: now().toISOString(),
              },
            };
            publish(completed);
            return snapshot(
              readConfigTransactionSources(prepare(current.target)),
              completed,
            );
          },
          { waitMs: 1000, signal: abort.signal },
        );
      } catch (error) {
        if (intentAttempted) {
          held = true;
          throw unknown();
        }
        if (error instanceof EnvironmentSettingsError) throw error;
        if (
          error instanceof ConfigTransactionError &&
          error.reason === "changed"
        )
          throw stale();
        throw unavailable();
      } finally {
        operations.delete(operation);
        finish();
      }
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled([...operations]);
    },
  };
}

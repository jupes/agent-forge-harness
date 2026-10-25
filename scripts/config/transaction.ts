/** Trusted cooperating-writer boundary; no CLI, HTTP or durable receipt protocol. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { withQueueLock } from "../scheduler/queue-lock";
import { type LoadOptions, machineConfigFile } from "./load";
import {
  ConfigTransactionError,
  configChanged as changed,
  invalidConfigPath as refuse,
} from "./transaction-error";
import {
  type ConfigAddress as Address,
  type ConfigParentAnchor as Anchor,
  configAddress as address,
  checkedConfigAddress as checkedAddress,
  createConfigParentTransition,
  type ConfigFileIdentity as Identity,
  configFileIdentity as identity,
  verifyConfigParentTransition,
} from "./transaction-paths";
import {
  checkedConfigSourceLimit,
  readConfigDescriptor,
} from "./transaction-read";
import { windowsConfigLeafKind } from "./transaction-windows";
import type { ConfigByteSource, ConfigTarget } from "./write";

export { ConfigTransactionError } from "./transaction-error";

export interface PreparedConfigTransaction {
  readonly target: ConfigTarget;
  readonly files: Readonly<Record<ConfigTarget, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly lockFile: string;
}

interface Prepared {
  addresses: Record<ConfigTarget, Address>;
  coordination: Address;
  maxSourceBytes: number | undefined;
}
const contexts = new WeakMap<PreparedConfigTransaction, Prepared>();

export type ConfigFileRevision = Readonly<{
  file: string;
  parent: Anchor;
  leaf:
    | (Identity &
        Readonly<{
          byteLength: number;
          sha256: string;
          mtimeNs: string;
          ctimeNs: string;
        }>)
    | null;
}>;
export type ConfigPairedRevision = Readonly<
  Record<ConfigTarget, ConfigFileRevision>
>;

export interface ConfigPublication {
  file: string;
  created: boolean;
  sha256: string;
}

export interface ConfigWriteTransaction {
  /** Fresh copies on every access, never aliases of the private comparison bytes. */
  readonly sources: Readonly<Record<ConfigTarget, ConfigByteSource>>;
  readonly revision: ConfigPairedRevision;
  publish(bytes: Uint8Array): ConfigPublication;
}

const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function checkWindowsLeaf(file: string): void {
  if (process.platform === "win32" && windowsConfigLeafKind(file) !== "plain")
    refuse(
      `${file}: a reparse point or unverified configuration leaf is not written; edit it by hand.`,
    );
}
/** Capture actual OS-user coordination, locations and env before any await; NOWRITE. */
export function prepareConfigTransaction(input: {
  options: LoadOptions;
  target: ConfigTarget;
  /** Trusted internal test seam; never supplied by an operator request. */
  coordinationRoot?: string;
  /** Frozen trusted logical selectors; their current physical parents are resolved per preparation. */
  fileSelectors?: Readonly<Record<ConfigTarget, string>>;
  /** Trusted caller policy for every source capture/readback, never a public request field. */
  maxSourceBytes?: number;
}): PreparedConfigTransaction {
  if (input.target !== "user" && input.target !== "workspace")
    refuse("Expected user or workspace target.");
  const maxSourceBytes = checkedConfigSourceLimit(input.maxSourceBytes),
    coordinationRoot =
      input.coordinationRoot ??
      join(homedir(), ".agent-forge-config-transactions");
  const fileSelectors = input.fileSelectors ?? {
    user: machineConfigFile(input.options),
    workspace: join(input.options.harnessRoot, "agent-forge.toml"),
  };
  const addresses = {
    user: address(fileSelectors.user),
    workspace: address(fileSelectors.workspace),
  };
  const coordination = address(join(coordinationRoot, "write.lock.db"));
  const context: PreparedConfigTransaction = Object.freeze({
    target: input.target,
    files: Object.freeze({
      user: addresses.user.file,
      workspace: addresses.workspace.file,
    }),
    env: Object.freeze({ ...(input.options.env ?? process.env) }),
    lockFile: coordination.file,
  });
  contexts.set(context, { addresses, coordination, maxSourceBytes });
  return context;
}

function capture(expected: Address, maxSourceBytes: number | undefined) {
  const current = checkedAddress(expected);
  let fd: number | undefined;
  let present = false;
  try {
    const before = lstatSync(current.file, { bigint: true });
    present = true;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      refuse(
        `${current.file}: linked, multiply linked or non-file configuration leaves are not written; edit them by hand.`,
      );
    checkWindowsLeaf(current.file);
    fd = openSync(
      current.file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(fd, { bigint: true });
    if (
      !same(identity(before), identity(opened)) ||
      !opened.isFile() ||
      opened.nlink !== 1n
    )
      changed();
    const bytes = readConfigDescriptor(fd, opened.size, maxSourceBytes);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(current.file, { bigint: true });
    checkWindowsLeaf(current.file);
    const stable = (info: typeof opened) => ({
      identity: identity(info),
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
      nlink: info.nlink,
    });
    if (
      !same(stable(opened), stable(after)) ||
      !same(stable(after), stable(named)) ||
      named.isSymbolicLink()
    )
      changed();
    const revision: ConfigFileRevision = Object.freeze({
      file: current.file,
      parent: current.anchor,
      leaf: Object.freeze({
        ...identity(after),
        byteLength: bytes.length,
        sha256: hash(bytes),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs),
      }),
    });
    return { bytes, revision };
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    if (present) changed();
    const revision: ConfigFileRevision = Object.freeze({
      file: current.file,
      parent: current.anchor,
      leaf: null,
    });
    return { bytes: null, revision };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function mutexIdentity(file: string): Identity | null {
  try {
    const info = lstatSync(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
      refuse(
        "The configuration mutex is linked or invalid; its data has been kept.",
      );
    checkWindowsLeaf(file);
    return identity(info);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** Create only an absent persistent mutex, without replacing any existing inode. */
function initializeMutex(file: string): Identity {
  const existing = mutexIdentity(file);
  if (existing !== null) return existing;
  let fd: number | undefined;
  try {
    fd = openSync(file, "wx", 0o600);
    const created = identity(fstatSync(fd, { bigint: true }));
    if (!same(mutexIdentity(file), created)) changed();
    return created;
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
    return mutexIdentity(file) ?? changed();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function prepared(context: PreparedConfigTransaction): Prepared {
  return (
    contexts.get(context) ??
    refuse("Expected a prepared configuration transaction.")
  );
}

function snapshot(context: PreparedConfigTransaction) {
  const { addresses, maxSourceBytes } = prepared(context);
  const user = capture(addresses.user, maxSourceBytes);
  const workspace = capture(addresses.workspace, maxSourceBytes);
  return {
    values: { user, workspace },
    revision: Object.freeze({
      user: user.revision,
      workspace: workspace.revision,
    }),
  };
}

/** Read-only optimistic review; authority is rechecked under the write mutex. */
export function readConfigTransactionSources(
  context: PreparedConfigTransaction,
) {
  const found = snapshot(context);
  return { sources: copiedSources(found), revision: found.revision };
}

function copiedSources(
  found: ReturnType<typeof snapshot>,
): Record<ConfigTarget, ConfigByteSource> {
  const source = (target: ConfigTarget) =>
    Object.freeze({
      file: found.revision[target].file,
      bytes:
        found.values[target].bytes === null
          ? null
          : Buffer.from(found.values[target].bytes),
    });
  return Object.freeze({
    user: source("user"),
    workspace: source("workspace"),
  });
}

/** One held transaction, shared by scalar CLI writes and the future create coordinator. */
export async function withConfigTransaction<T>(
  context: PreparedConfigTransaction,
  work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  options: {
    waitMs?: number;
    signal?: AbortSignal;
    expectedRevision?: ConfigPairedRevision;
  } = {},
): Promise<T> {
  const state = prepared(context);
  const { signal, waitMs } = options;
  const expectedRevision =
    options.expectedRevision === undefined
      ? undefined
      : structuredClone(options.expectedRevision);
  const assertOpen = () => {
    if (signal?.aborted)
      throw new ConfigTransactionError(
        "closed",
        "The configuration write was cancelled.",
      );
  };
  assertOpen();
  checkedAddress(state.coordination);
  // The mutex is binary SQLite, not one of home-guard's checked text files.
  ensurePrivateHome(dirname(context.lockFile));
  checkedAddress(state.coordination);
  const expectedMutex = initializeMutex(context.lockFile);
  const run = async () => {
    assertOpen();
    checkedAddress(state.coordination);
    const assertMutex = () => {
      checkedAddress(state.coordination);
      if (!same(mutexIdentity(context.lockFile), expectedMutex)) changed();
    };
    assertMutex();
    const found = snapshot(context);
    if (
      expectedRevision !== undefined &&
      !same(found.revision, expectedRevision)
    )
      changed();
    let active = true;
    let used = false;
    let replacementAttempted = false;
    const transaction: ConfigWriteTransaction = Object.freeze({
      get sources() {
        return copiedSources(found);
      },
      revision: found.revision,
      publish(candidate: Uint8Array) {
        assertOpen();
        if (!active || used)
          throw new ConfigTransactionError(
            "closed",
            "This configuration publisher is closed or was already used.",
          );
        used = true;
        assertMutex();
        const bytes = Buffer.from(candidate);
        if (!same(snapshot(context).revision, found.revision)) changed();
        const selected = state.addresses[context.target];
        const transition = createConfigParentTransition(
          selected,
          found.revision[context.target].parent,
        );
        const before = snapshot(context);
        for (const target of ["user", "workspace"] as const) {
          const current = before.revision[target];
          const previous = found.revision[target];
          const authorized =
            target === context.target
              ? { ...previous, parent: transition.after }
              : previous;
          if (!same(current, authorized)) changed();
        }
        verifyConfigParentTransition(selected, transition);
        const file = context.files[context.target];
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        let attempted = false;
        let draft: Identity | undefined;
        try {
          const fd = openSync(temporary, "wx");
          try {
            draft = identity(fstatSync(fd, { bigint: true }));
            writeFileSync(fd, bytes);
          } finally {
            closeSync(fd);
          }
          assertMutex();
          verifyConfigParentTransition(selected, transition);
          if (!same(snapshot(context).revision, before.revision)) changed();
          attempted = true;
          replacementAttempted = true;
          renameSync(temporary, file);
          assertMutex();
          verifyConfigParentTransition(selected, transition);
          const afterFound = snapshot(context);
          verifyConfigParentTransition(selected, transition);
          const unselected = context.target === "user" ? "workspace" : "user";
          if (
            !same(afterFound.revision[unselected], before.revision[unselected])
          )
            changed();
          const after = afterFound.values[context.target];
          if (
            after.bytes === null ||
            !after.bytes.equals(bytes) ||
            !same(
              after.revision.leaf === null
                ? null
                : {
                    dev: after.revision.leaf.dev,
                    ino: after.revision.leaf.ino,
                  },
              draft,
            )
          )
            throw new ConfigTransactionError(
              "unconfirmed",
              "Replacement was attempted, but its published bytes could not be confirmed.",
              true,
            );
          return {
            file,
            created: found.revision[context.target].leaf === null,
            sha256: hash(bytes),
          };
        } catch (error) {
          if (
            attempted &&
            !(
              error instanceof ConfigTransactionError &&
              error.replacementAttempted
            )
          )
            throw new ConfigTransactionError(
              "unconfirmed",
              "Configuration replacement was attempted but could not be confirmed.",
              true,
            );
          throw error;
        } finally {
          if (draft !== undefined) {
            try {
              const current = lstatSync(temporary, { bigint: true });
              if (
                current.isFile() &&
                !current.isSymbolicLink() &&
                current.nlink === 1n &&
                same(identity(current), draft)
              )
                rmSync(temporary);
            } catch {
              /* Cleanup must not overwrite an attempted/unconfirmed result. */
            }
          }
        }
      },
    });
    let detach = () => {};
    try {
      const pending = Promise.resolve().then(() => {
        assertOpen();
        return work(transaction);
      });
      if (signal === undefined) return await pending;
      const aborted = new Promise<never>((_done, reject) => {
        const listener = () =>
          reject(
            new ConfigTransactionError(
              replacementAttempted ? "unconfirmed" : "closed",
              replacementAttempted
                ? "The configuration transaction ended after replacement was attempted; its overall result is unconfirmed."
                : "The configuration write was cancelled.",
              replacementAttempted,
            ),
          );
        signal.addEventListener("abort", listener, { once: true });
        detach = () => signal.removeEventListener("abort", listener);
        if (signal.aborted) listener();
      });
      return await Promise.race([pending, aborted]);
    } catch (error) {
      if (
        replacementAttempted &&
        !(error instanceof ConfigTransactionError && error.replacementAttempted)
      )
        throw new ConfigTransactionError(
          "unconfirmed",
          "The configuration transaction failed after replacement was attempted; its overall result is unconfirmed.",
          true,
        );
      throw error;
    } finally {
      active = false;
      detach();
    }
  };
  const locked = await withQueueLock(
    context.lockFile,
    run,
    waitMs === undefined ? {} : { waitMs },
  );
  if (!locked.ok)
    throw new ConfigTransactionError(
      locked.reason,
      locked.reason === "busy"
        ? "Another configuration write is in progress; no configuration replacement was attempted."
        : "The configuration mutex could not be taken; no configuration replacement was attempted.",
    );
  return locked.value;
}

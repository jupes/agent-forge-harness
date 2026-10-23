import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  type LoginProvider,
  loginProviderSchema,
  loginRequestIdSchema,
  type ProviderLogin,
  providerLoginSchema,
} from "./login-protocol";
import {
  launchWindowsConsole,
  type NativeConsoleChild,
  type NativeConsoleExit,
} from "./native-console";

const MAX_BYTES = 262144;
const markerSchema = z
  .object({
    version: z.literal(1),
    provider: loginProviderSchema,
    requestId: loginRequestIdSchema,
    startedAt: z.iso.datetime(),
  })
  .strict();
const journal = z
  .object({
    version: z.literal(1),
    records: z.array(providerLoginSchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((row) => row.requestId)).size ===
      value.records.length,
  );
type Journal = z.infer<typeof journal>;
function folder(home: string, root: string) {
  const canonical = realpathSync.native(root),
    key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return join(
    home,
    "provider-logins",
    createHash("sha256").update(key).digest("hex").slice(0, 32),
  );
}
export const providerLoginFile = (home: string, root: string) =>
  join(folder(home, root), "attempts.json");
function unavailable(): never {
  throw new ConversationError(
    503,
    "The private sign-in identities are unavailable. Saved bytes have been kept; check the original request.",
  );
}
function closeLease(db: Database) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* already closed */
  }
  try {
    db.close();
  } catch {
    /* process exit also releases it */
  }
}

/** Fixed vendor flows only. Durable UUIDs never replay, including after host recreation. */
export function createProviderLoginService(options: {
  root: string;
  home: string;
  prepare(
    provider: LoginProvider,
  ): Promise<Parameters<typeof launchWindowsConsole>[0]>;
  launch?: typeof launchWindowsConsole;
}) {
  const parent = join(options.home, "provider-logins"),
    directory = folder(options.home, options.root),
    file = providerLoginFile(options.home, options.root),
    lock = join(directory, "attempts.lock.db");
  const active = new Map<
    string,
    { child: NativeConsoleChild; finished: Promise<void> }
  >();
  let closing = false;
  function paths() {
    for (const [path, directoryPath] of [
      [parent, true],
      [directory, true],
      [file, false],
      [lock, false],
      ...["claude", "codex"].map(
        (provider) => [join(parent, `${provider}.lease.db`), false] as const,
      ),
      ...["claude", "codex"].map(
        (provider) => [join(parent, `${provider}.latest.json`), false] as const,
      ),
    ] as const) {
      try {
        const info = lstatSync(path);
        if (
          info.isSymbolicLink() ||
          (directoryPath
            ? !info.isDirectory()
            : !info.isFile() || info.nlink !== 1)
        )
          unavailable();
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable();
      }
    }
    if (
      readHomeFile(parent).problem !== null ||
      readHomeFile(directory).problem !== null
    )
      unavailable();
  }
  function state(): Journal {
    paths();
    const read = readSessionTranscript(options.home, file);
    if (read.problem !== null) unavailable();
    if (read.text === null) return { version: 1, records: [] };
    let raw: unknown;
    try {
      if (Buffer.byteLength(read.text) > MAX_BYTES) unavailable();
      raw = JSON.parse(read.text);
    } catch {
      unavailable();
    }
    const parsed = journal.safeParse(raw);
    if (!parsed.success) unavailable();
    return parsed.data;
  }
  function write(value: Journal) {
    const text = JSON.stringify(value);
    if (
      !journal.safeParse(value).success ||
      Buffer.byteLength(text) > MAX_BYTES
    )
      unavailable();
    try {
      writeOwnerOnly(file, text);
    } catch {
      unavailable();
    }
  }
  function lease(provider: LoginProvider): Database | null {
    paths();
    ensurePrivateHome(options.home);
    ensurePrivateHome(parent);
    ensurePrivateHome(directory);
    let db: Database | undefined;
    try {
      db = new Database(join(parent, `${provider}.lease.db`), {
        create: true,
      });
      db.exec("PRAGMA busy_timeout=0");
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (error) {
      if (db) closeLease(db);
      if (
        /BUSY|LOCKED/i.test(String((error as { code?: unknown }).code)) ||
        /database is locked/i.test(String(error))
      )
        return null;
      unavailable();
    }
  }
  function identity(provider: string, requestId: string) {
    if (
      !loginProviderSchema.safeParse(provider).success ||
      !loginRequestIdSchema.safeParse(requestId).success
    )
      throw new ConversationError(
        400,
        "Expected a supported sign-in provider and request UUID.",
      );
  }
  function receipt(row: ProviderLogin): ProviderLogin {
    if (
      row.phase === "closed" ||
      row.phase === "interrupted" ||
      active.has(row.requestId)
    )
      return { ...row };
    const probe = lease(row.provider);
    if (!probe) return { ...row, phase: "unknown" };
    closeLease(probe);
    // This lease is released only after the owned job settles, or by OS process death.
    return { ...row, phase: "interrupted" };
  }
  function read(provider: string, requestId: string) {
    identity(provider, requestId);
    const row = state().records.find(
      (record) => record.requestId === requestId,
    );
    if (!row)
      throw new ConversationError(
        404,
        "No original sign-in request was found.",
      );
    if (row.provider !== provider)
      throw new ConversationError(
        409,
        "This sign-in UUID belongs to a different provider.",
      );
    return receipt(row);
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    paths();
    ensurePrivateHome(options.home);
    ensurePrivateHome(parent);
    ensurePrivateHome(directory);
    const result = await withQueueLock(lock, work, { waitMs: 2000 });
    if (!result.ok) unavailable();
    return result.value;
  }
  async function complete(requestId: string, result: NativeConsoleExit | null) {
    await locked(async () => {
      const value = state(),
        row = value.records.find((record) => record.requestId === requestId);
      if (!row) unavailable();
      row.phase = result ? "closed" : "unknown";
      row.endedAt = new Date().toISOString();
      if (result) {
        row.exitCode = result.exitCode;
        row.stopped = result.stopped;
        row.timedOut = result.timedOut;
      }
      write(value);
    });
  }
  function latestAttempt(provider: LoginProvider) {
    paths();
    const found = readSessionTranscript(
      options.home,
      join(parent, `${provider}.latest.json`),
    );
    if (found.problem !== null) unavailable();
    if (found.text === null) return null;
    let raw: unknown;
    try {
      if (found.text.length > 1024) unavailable();
      raw = JSON.parse(found.text);
    } catch {
      unavailable();
    }
    const parsed = markerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.provider !== provider) unavailable();
    return parsed.data;
  }
  return {
    read,
    latestAttempt,
    latestStartedAt: (provider: LoginProvider) =>
      latestAttempt(provider)?.startedAt ?? null,
    list() {
      return state().records.map(receipt);
    },
    async start(
      provider: LoginProvider,
      requestId: string,
    ): Promise<ProviderLogin> {
      identity(provider, requestId);
      return locked(async () => {
        const value = state(),
          existing = value.records.find((row) => row.requestId === requestId);
        if (existing) return read(provider, requestId);
        if (closing)
          throw new ConversationError(
            503,
            "The sign-in service is closing. No new terminal was opened.",
          );
        if (value.records.length >= 256) unavailable();
        const held = lease(provider);
        if (!held)
          throw new ConversationError(
            409,
            "A vendor sign-in terminal is already open. Check its original request.",
          );
        let handedOff = false;
        try {
          const spec = await options.prepare(provider);
          if (closing)
            throw new ConversationError(
              503,
              "The sign-in service is closing. No new terminal was opened.",
            );
          for (const old of value.records)
            if (old.provider === provider && old.phase !== "closed")
              old.phase = "interrupted";
          const row: ProviderLogin = {
            provider,
            requestId,
            phase: "opening",
            startedAt: new Date().toISOString(),
            endedAt: null,
            exitCode: null,
            stopped: false,
            timedOut: false,
          };
          value.records.push(row);
          // This immutable original/attempt marker must reach private storage before CreateProcessW.
          write(value);
          try {
            writeOwnerOnly(
              join(parent, `${provider}.latest.json`),
              JSON.stringify(
                markerSchema.parse({
                  version: 1,
                  provider,
                  requestId,
                  startedAt: row.startedAt,
                }),
              ),
            );
          } catch {
            unavailable();
          }
          let child: NativeConsoleChild;
          try {
            child = (options.launch ?? launchWindowsConsole)(spec);
          } catch {
            row.phase = "unknown";
            write(value);
            throw new ConversationError(
              503,
              "The terminal outcome could not be confirmed. Check the original sign-in request before trying again.",
            );
          }
          const finished = child.done
            .then(
              (result) => complete(requestId, result),
              () => complete(requestId, null),
            )
            .catch(() => {
              /* Original identity remains held; no replay after a failed terminal receipt. */
            })
            .finally(() => {
              closeLease(held);
              active.delete(requestId);
            });
          active.set(requestId, { child, finished });
          handedOff = true;
          row.phase = "running";
          write(value);
          return { ...row };
        } finally {
          if (!handedOff) closeLease(held);
        }
      });
    },
    async stop(provider: LoginProvider, requestId: string) {
      const current = read(provider, requestId),
        owned = active.get(requestId);
      if (!owned) {
        if (current.phase === "unknown")
          throw new ConversationError(
            409,
            "This terminal belongs to another active host. Close its vendor window and check the original request.",
          );
        return current;
      }
      await owned.child.stop();
      await owned.finished;
      return read(provider, requestId);
    },
    async close() {
      closing = true;
      await Promise.allSettled(
        [...active.values()].map(async (entry) => {
          await entry.child.stop();
          await entry.finished;
        }),
      );
    },
  };
}
export type ProviderLoginService = ReturnType<
  typeof createProviderLoginService
>;

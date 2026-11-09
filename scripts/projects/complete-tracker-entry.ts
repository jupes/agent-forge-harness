import { SQL } from "bun";
import {
  captureOwnTracker,
  type OwnTrackerDescriptor,
  sameOwnTracker,
} from "./complete-tracker-descriptor";
import {
  COMPLETE_TRACKER_BYTES,
  COMPLETE_TRACKER_SQL,
  parseCompleteTracker,
} from "./complete-tracker-source";

export interface TrackerDatabase {
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
export type TrackerDatabaseFactory = (
  descriptor: OwnTrackerDescriptor,
) => TrackerDatabase;
function connect(descriptor: OwnTrackerDescriptor): TrackerDatabase {
  const sql = new SQL({
    adapter: "mysql",
    hostname: "127.0.0.1",
    port: descriptor.port,
    username: "root",
    password: "",
    database: descriptor.database,
    tls: false,
    max: 1,
    connectionTimeout: 2,
    idleTimeout: 0,
    maxLifetime: 4,
    bigint: false,
  });
  return {
    query: async (statement) => sql.unsafe(statement),
    close: () => sql.close({ timeout: 0 }),
  };
}

/** Core actual read, injectable only for isolated headless fixtures. */
export async function readCompleteTrackerOnce(
  descriptor: OwnTrackerDescriptor,
  create: TrackerDatabaseFactory = connect,
): Promise<string> {
  if (!sameOwnTracker(descriptor))
    throw Error("Complete workspace tracker unavailable.");
  const database = create(descriptor);
  let closed = false;
  try {
    // Pinned Bun1.4.2 converts DATETIME using UTC arithmetic, not local time:
    // https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/sql_jsc/mysql/MySQLValue.rs#L556
    const rows = await database.query(COMPLETE_TRACKER_SQL);
    if (!Array.isArray(rows)) throw Error();
    for (const row of rows) {
      if (!row || typeof row !== "object") throw Error();
      for (const key of ["created_at", "updated_at", "due_at"]) {
        const value: unknown = row[key];
        // Invalid Date serializes to null: never let it impersonate no due date.
        if (
          value !== null &&
          (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        )
          throw Error();
      }
    }
    const stdout = JSON.stringify(rows);
    if (Buffer.byteLength(stdout) > COMPLETE_TRACKER_BYTES) throw Error();
    parseCompleteTracker(stdout, {
      database: descriptor.database,
      projectId: descriptor.projectId,
    });
    if (!sameOwnTracker(descriptor)) throw Error();
    closed = true;
    await database.close();
    return stdout;
  } catch {
    throw Error("Complete workspace tracker unavailable.");
  } finally {
    if (!closed) {
      try {
        await database.close();
      } catch {
        // Retain the original sanitized read refusal; the helper exits nonzero.
      }
    }
  }
}

/** Internal fixed child mode. Parent accepts output only after successful exit. */
export async function completeTrackerEntry(
  args: readonly string[],
): Promise<void> {
  // A stuck native read OR teardown has an OS-process lifetime bound.
  const deadline = setTimeout(() => process.exit(2), 5000);
  try {
    if (args.length !== 2 || !/^[a-f0-9]{64}$/.test(args[1] ?? ""))
      throw Error();
    const descriptor = captureOwnTracker(args[0]!);
    if (descriptor.fingerprint !== args[1]) throw Error();
    process.stdout.write(await readCompleteTrackerOnce(descriptor));
  } catch {
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

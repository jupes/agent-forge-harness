/** TEST ONLY. A fixed MySQL protocol peer; it does NOT execute SQL or qualify Dolt. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { withQueueLock } from "../../scheduler/queue-lock";
import { captureOwnTracker } from "../complete-tracker-descriptor";
import { completeTrackerFixture } from "../complete-tracker-fixture";
import {
  COMPLETE_TRACKER_SQL,
  type TrackerIdentity,
} from "../complete-tracker-source";
import { completeFixtureModel } from "../complete-tracker-test-model";

const MAX_PACKET = 65_536,
  MAX_RESPONSE = 1_048_576;
const rowSchema = z
  .object({
    part: z.string().max(32),
    payload: z.string().max(MAX_RESPONSE),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    due_at: z.string().nullable(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
const names = [
  "part",
  "payload",
  "created_at",
  "updated_at",
  "due_at",
] as const;
const capabilities = 0x0008a20d; // protocol41, DB, secure empty auth, plugin auth; no TLS/deprecate-EOF.
const ok = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
const eof = Buffer.from([0xfe, 0, 0, 2, 0]);
function integer(value: number, size: number) {
  const bytes = Buffer.alloc(size);
  bytes.writeUIntLE(value, 0, size);
  return bytes;
}
function string(value: string) {
  const bytes = Buffer.from(value);
  const length =
    bytes.length < 251
      ? Buffer.from([bytes.length])
      : bytes.length < 65536
        ? Buffer.concat([Buffer.from([0xfc]), integer(bytes.length, 2)])
        : Buffer.concat([Buffer.from([0xfd]), integer(bytes.length, 3)]);
  return Buffer.concat([length, bytes]);
}
function packet(value: Buffer, sequence: number) {
  if (value.length > MAX_RESPONSE)
    throw Error("Fixture response exceeded its bound.");
  return Buffer.concat([
    integer(value.length, 3),
    Buffer.from([sequence & 255]),
    value,
  ]);
}
function column(name: string, index: number) {
  return Buffer.concat([
    string("def"),
    string("isolated_fixture"),
    string(""),
    string(""),
    string(name),
    string(""),
    Buffer.from([12]),
    integer(45, 2),
    integer(MAX_RESPONSE, 4),
    Buffer.from([index < 2 ? 0xfd : 0x0c]),
    integer(0, 2),
    Buffer.from([0, 0, 0]),
  ]);
}
function textRow(row: Row) {
  return Buffer.concat(
    names.map((name, index) => {
      const value = row[name];
      if (value === null) return Buffer.from([0xfb]);
      if (index < 2) return string(value);
      const time = new Date(value);
      if (!Number.isFinite(time.getTime()))
        throw Error("Invalid fixture date.");
      return string(time.toISOString().replace("T", " ").slice(0, 23) + "000");
    }),
  );
}
function greeting() {
  return Buffer.concat([
    Buffer.from([10]),
    Buffer.from("8.0.36-fixture\0"),
    integer(1, 4),
    Buffer.from("fixture1"),
    Buffer.from([0]),
    integer(capabilities & 0xffff, 2),
    Buffer.from([45]),
    integer(2, 2),
    integer(capabilities >>> 16, 2),
    Buffer.from([21]),
    Buffer.alloc(10),
    Buffer.from("fixture23456\0"),
    Buffer.from("mysql_native_password\0"),
  ]);
}
function authenticated(payload: Buffer, database: string) {
  if (payload.length < 34) return false;
  const flags = payload.readUInt32LE(0);
  if (flags & 0x800 || !(flags & 0x8000) || !(flags & 8)) return false;
  const userEnd = payload.indexOf(0, 32);
  if (userEnd < 0 || payload.toString("utf8", 32, userEnd) !== "root")
    return false;
  const authLength = payload[userEnd + 1];
  if (authLength !== 0) return false;
  const dbStart = userEnd + 2,
    dbEnd = payload.indexOf(0, dbStart);
  return (
    dbEnd >= dbStart && payload.toString("utf8", dbStart, dbEnd) === database
  );
}

/** Uses the unmodified default Bun SQL client, including its no-parameter text-query results.
 * Pinned source: bun-v1.4.2 src/js/bun/sql.ts unsafeQuery and src/sql_jsc/mysql/MySQLConnection.rs.
 */
export async function completeTrackerMysqlFixture(options: {
  root: string;
  snapshot: (identity: TrackerIdentity) => Promise<string>;
}) {
  const identity = { database: "isolated_fixture", projectId: randomUUID() };
  const sockets = new Set<Socket>(),
    pending = new Set<Promise<void>>(),
    snapshots = new Set<Promise<string>>();
  const stats = {
    snapshots: 0,
    rejected: 0,
    connections: 0,
    rejectedPhase: "",
    rejectedCommand: -1,
  };
  let closed = false,
    closing: Promise<void> | null = null;
  const server = createServer((socket) => {
    if (closed || sockets.size >= 8 || ++stats.connections > 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let input = Buffer.alloc(0),
      totalBytes = 0,
      messages = 0;
    let phase: "auth" | "timezone" | "query" = "auth",
      lastCommand = -1,
      retired = false,
      readOnce = false;
    let chain = Promise.resolve();
    const reject = (sequence: number) => {
      retired = true;
      stats.rejected++;
      stats.rejectedPhase = phase;
      stats.rejectedCommand = lastCommand;
      socket.end(
        packet(
          Buffer.concat([
            Buffer.from([0xff]),
            integer(1105, 2),
            Buffer.from("#HY000Fixture command refused"),
          ]),
          sequence,
        ),
      );
    };
    const handle = async (payload: Buffer, sequence: number) => {
      if (closed || retired || socket.destroyed) return;
      lastCommand = payload[0] ?? -1;
      if (phase === "auth") {
        if (sequence !== 1 || !authenticated(payload, identity.database)) {
          reject(2);
          return;
        }
        phase = "timezone";
        socket.write(packet(ok, 2));
        return;
      }
      if (sequence !== 0 || !payload.length) {
        reject(1);
        return;
      }
      const command = payload[0];
      if (command === 1 && payload.length === 1) {
        retired = true;
        socket.end();
        return;
      }
      // Pinned MySQLConnection.rs sends exactly this command before accepting queries.
      if (phase === "timezone") {
        if (
          command !== 3 ||
          payload.subarray(1).toString() !== "SET time_zone = '+00:00'"
        ) {
          reject(1);
          return;
        }
        phase = "query";
        socket.write(packet(ok, 1));
        return;
      }
      // Bun1.4.2 unsafeQuery sets simple mode when no parameters are supplied.
      if (
        command !== 3 ||
        readOnce ||
        payload.subarray(1).toString() !== COMPLETE_TRACKER_SQL ||
        ++stats.snapshots > 256
      ) {
        reject(1);
        return;
      }
      readOnce = true;
      const operation = Promise.resolve().then(() =>
        options.snapshot(identity),
      );
      snapshots.add(operation);
      void operation.then(
        () => snapshots.delete(operation),
        () => snapshots.delete(operation),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const text = await Promise.race([
          operation,
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(Error("Fixture source timed out.")),
              1000,
            );
          }),
        ]);
        if (Buffer.byteLength(text) > MAX_RESPONSE) throw Error();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw Error();
        }
        const rows = z.array(rowSchema).max(128).parse(raw);
        if (closed || socket.destroyed) return;
        let sequence = 1;
        const packets = [
          packet(Buffer.from([5]), sequence++),
          ...names.map((name, index) =>
            packet(column(name, index), sequence++),
          ),
          packet(eof, sequence++),
          ...rows.map((row) => packet(textRow(row), sequence++)),
          packet(eof, sequence++),
        ];
        const response = Buffer.concat(packets);
        if (response.length > MAX_RESPONSE) throw Error();
        socket.write(response);
      } catch {
        if (!closed && !socket.destroyed) reject(1);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    socket.write(packet(greeting(), 0));
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += bytes.length;
      if (totalBytes > MAX_PACKET * 2) {
        socket.destroy();
        return;
      }
      input = Buffer.concat([input, bytes]);
      while (input.length >= 4) {
        const length = input.readUIntLE(0, 3);
        if (length > MAX_PACKET || ++messages > 64) {
          socket.destroy();
          return;
        }
        if (input.length < length + 4) {
          messages--;
          return;
        }
        const sequence = input[3]!,
          body = Buffer.from(input.subarray(4, length + 4));
        input = input.subarray(length + 4);
        chain = chain
          .then(() => handle(body, sequence))
          .catch(() => {
            socket.destroy();
          });
        const current = chain;
        pending.add(current);
        void current.finally(() => pending.delete(current));
      }
    });
  });
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      clearTimeout(lifetime);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...snapshots]);
    })());
  let lifetime: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  lifetime = setTimeout(() => {
    void close();
  }, 180_000);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error();
    const beads = join(options.root, ".beads");
    mkdirSync(beads); // Refuse existing descriptors, never overwrite a real tracker.
    writeFileSync(
      join(beads, "metadata.json"),
      JSON.stringify({
        backend: "dolt",
        dolt_mode: "server",
        dolt_database: identity.database,
        project_id: identity.projectId,
      }),
      { flag: "wx" },
    );
    writeFileSync(join(beads, "dolt-server.port"), String(address.port), {
      flag: "wx",
    });
    return {
      identity,
      descriptor: captureOwnTracker(options.root),
      stats,
      close,
    };
  } catch {
    await close();
    throw Error("Isolated MySQL fixture initialization failed.");
  }
}

/** Explicit closed-world tracker.json simulation, serialized with the SAME fixture lock as bd. */
export function attendedCompleteTrackerFixture(root: string) {
  if (
    readFileSync(join(root, "attended-native-fixture.marker"), "utf8") !==
    "agent-forge-attended-native-fixture-v1"
  )
    throw Error("Fixture marker required.");
  return completeTrackerMysqlFixture({
    root,
    snapshot: async (identity) => {
      const locked = await withQueueLock(
        join(root, "fixture/tracker.lock.db"),
        async () => {
          const file = readFileSync(join(root, "fixture/tracker.json"), "utf8");
          if (Buffer.byteLength(file) > MAX_RESPONSE) throw Error();
          let raw: unknown;
          try {
            raw = JSON.parse(file);
          } catch {
            throw Error();
          }
          const rows = z
            .array(
              z
                .object({
                  id: z.string(),
                  title: z.string(),
                  issueType: z.string(),
                  status: z.string().optional(),
                  labels: z.array(z.string()),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                  description: z.string().optional(),
                  parent: z.object({ id: z.string() }).optional(),
                  comments: z.array(z.string()).optional(),
                })
                .strict(),
            )
            .max(10)
            .parse(raw);
          const model = completeFixtureModel({
            status: 0,
            stderr: "",
            stdout: rows
              .map((row) =>
                JSON.stringify({
                  id: row.id,
                  title: row.title,
                  issue_type: row.issueType,
                  status: row.status ?? "open",
                  priority: 2,
                  description: row.description ?? "",
                  labels: row.labels,
                  metadata: row.metadata ?? {},
                  dependencies: row.parent
                    ? [
                        {
                          issue_id: row.id,
                          depends_on_id: row.parent.id,
                          type: "parent-child",
                        },
                      ]
                    : [],
                }),
              )
              .join("\n"),
          });
          return completeTrackerFixture(
            identity,
            model.rows.map((row) => ({
              ...row,
              acceptance_criteria: row.acceptance_criteria ?? "",
            })),
          );
        },
        { waitMs: 1000 },
      );
      if (!locked.ok) throw Error("Fixture tracker unavailable.");
      return locked.value;
    },
  });
}

import { lstatSync } from "node:fs";
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
  type ProjectBudgetStatus,
  type ProjectCouncilBudget,
  usdMicros,
} from "./project-budgets-protocol";
import { createProjectStore, isProjectId } from "./store";

const micro = usdMicros;
const allocation = z
  .object({
    projectId: z.string(),
    requestId: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    allocation: z.number().int().positive().max(1_000_000_000_000),
    actual: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    actualUsd: z.number().finite().nonnegative().nullable(),
    estimated: z.number().finite().nonnegative().nullable(),
    state: z.enum(["attempted", "settled", "unknown"]),
  })
  .strict();
const schema = z
  .object({ version: z.literal(1), records: z.array(allocation).max(4096) })
  .strict()
  .refine((value) => {
    try {
      return (
        new Set(value.records.map((row) => `${row.projectId}/${row.requestId}`))
          .size === value.records.length &&
        value.records.every(
          (row) =>
            isProjectId(row.projectId) &&
            new Date(`${row.day}T00:00:00.000Z`).toISOString().slice(0, 10) ===
              row.day &&
            (row.state === "settled"
              ? row.actualUsd !== null &&
                row.actual === micro(row.actualUsd) &&
                row.estimated === null
              : row.actual === null && row.actualUsd === null) &&
            (row.state !== "attempted" || row.estimated === null),
        )
      );
    } catch {
      return false;
    }
  });
type State = z.infer<typeof schema>;
const fail = (message: string): never => {
  throw new ConversationError(503, message);
};

/** Durable local admission accounting; it is never a provider billing balance. */
export function createProjectBudgetStore(home: string, now = () => new Date()) {
  const directory = join(home, "project-budgets"),
    file = join(directory, "allocations.json"),
    lock = join(directory, "allocations.lock.db");
  const check = () => {
    for (const [path, folder] of [
      [directory, true],
      [file, false],
      [lock, false],
    ] as const) {
      try {
        const info = lstatSync(path);
        if (
          info.isSymbolicLink() ||
          (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        )
          fail("The private project budget path is linked or invalid.");
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          fail("The project budget path could not be checked.");
      }
    }
    if (readHomeFile(directory).problem !== null)
      fail("The project budget directory is not private.");
  };
  const read = (): State => {
    check();
    const found = readSessionTranscript(home, file);
    if (found.problem !== null)
      fail(
        "Project admission costs could not be read. No allocation was released.",
      );
    if (found.text === null) return { version: 1, records: [] };
    try {
      if (Buffer.byteLength(found.text) > 2_097_152) throw Error();
      return schema.parse(JSON.parse(found.text));
    } catch {
      return fail(
        "Project admission costs are invalid or full. No allocation was released.",
      );
    }
  };
  const day = () => now().toISOString().slice(0, 10);
  const project = (id: string) => {
    if (!isProjectId(id))
      throw new ConversationError(400, "Expected a project id.");
    const found = createProjectStore(home)
      .read()
      .projects.find((row) => row.id === id);
    if (!found) throw new ConversationError(404, "Project unavailable.");
    return found;
  };
  const status = (id: string, state = read()): ProjectBudgetStatus => {
    const cap = project(id).budgets?.dailyApiKeyCapUsd ?? null;
    const today = day();
    const rows = state.records.filter(
      (row) =>
        row.projectId === id && (row.day === today || row.state !== "settled"),
    );
    return {
      projectId: id,
      asOf: now().toISOString(),
      day: today,
      dailyCapUsd: cap,
      reportedUsd: rows.reduce((sum, row) => sum + (row.actualUsd ?? 0), 0),
      estimatedUsd: rows.reduce((sum, row) => sum + (row.estimated ?? 0), 0),
      reservedUsd:
        rows.reduce(
          (sum, row) => sum + (row.state === "settled" ? 0 : row.allocation),
          0,
        ) / 1_000_000,
      unknownCount: rows.filter((row) => row.state === "unknown").length,
    };
  };
  const mutate = async <T>(change: (state: State) => T): Promise<T> => {
    check();
    ensurePrivateHome(home);
    const changed = await withQueueLock(lock, async () => {
      const state = read(),
        result = change(state),
        text = JSON.stringify(schema.parse(state));
      if (Buffer.byteLength(text) > 2_097_152)
        fail("The project budget journal is full.");
      check();
      writeOwnerOnly(file, text);
      return result;
    });
    if (!changed.ok)
      return fail(
        "The project budget owner is busy. No provider was admitted.",
      );
    return changed.value;
  };
  const hooks: ProjectCouncilBudget = {
    async reserve(id, requestId, hash, allocationUsd) {
      await mutate((state) => {
        const current = project(id);
        if (current.archived)
          throw new ConversationError(
            409,
            "Unarchive this project before new API work.",
          );
        const existing = state.records.find(
          (row) => row.projectId === id && row.requestId === requestId,
        );
        if (existing) {
          if (
            existing.hash !== hash ||
            existing.allocation !== micro(allocationUsd)
          )
            throw new ConversationError(
              409,
              "The budget allocation does not match the original Council request.",
            );
          return;
        }
        const cap = current.budgets?.dailyApiKeyCapUsd;
        if (cap == null) return;
        if (
          !Number.isFinite(allocationUsd) ||
          allocationUsd <= 0 ||
          allocationUsd > 1_000_000 ||
          micro(allocationUsd) < 1
        )
          throw new ConversationError(
            409,
            "A daily-protected Council run needs a positive reviewed max USD allocation.",
          );
        const currentStatus = status(id, state);
        const charged = state.records
          .filter(
            (row) =>
              row.projectId === id &&
              (row.day === day() || row.state !== "settled"),
          )
          .reduce(
            (sum, row) =>
              sum + (row.state === "settled" ? row.actual! : row.allocation),
            0,
          );
        if (
          currentStatus.unknownCount ||
          charged + micro(allocationUsd) > micro(cap)
        )
          throw new ConversationError(
            409,
            "The project daily admission budget is exhausted or has unreported costs. No provider was called.",
          );
        if (state.records.length >= 4096)
          fail("The project budget journal is full. No provider was admitted.");
        state.records.push({
          projectId: id,
          requestId,
          hash,
          day: day(),
          allocation: micro(allocationUsd),
          actual: null,
          actualUsd: null,
          estimated: null,
          state: "attempted",
        });
      });
    },
    async settle(id, requestId, hash, result) {
      await mutate((state) => {
        const row = state.records.find(
          (item) => item.projectId === id && item.requestId === requestId,
        );
        if (!row) return; // The project had no daily protection at admission.
        if (row.hash !== hash)
          throw new ConversationError(409, "Budget receipt identity changed.");
        if (row.state === "settled") return;
        if (
          result &&
          !result.costIsEstimate &&
          result.actualCostUsd !== null &&
          Number.isFinite(result.actualCostUsd) &&
          result.actualCostUsd >= 0
        ) {
          row.actual = micro(result.actualCostUsd);
          row.actualUsd = result.actualCostUsd;
          row.estimated = null;
          row.state = "settled";
        } else {
          row.state = "unknown";
          if (
            result?.usageEstimatedCostUsd != null &&
            Number.isFinite(result.usageEstimatedCostUsd) &&
            result.usageEstimatedCostUsd >= 0
          )
            row.estimated = result.usageEstimatedCostUsd;
        }
      });
    },
  };
  return { ...hooks, status };
}

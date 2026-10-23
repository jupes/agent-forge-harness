import { z } from "zod";
import { SHIFT_STOP_REASONS } from "../../types/hearth";
import type {
  ProjectShiftIntent,
  ProjectShiftObservation,
} from "../../types/project-shifts";
import { SHIFT_LIMITS, SHIFT_MAX_USD } from "../config/defaults";
import { workspaceKey } from "../projects/scope";
import { runOptions } from "../scheduler/shift-cli-runtime";
import { SHIFT_BEAD_OUTCOMES } from "../scheduler/shift-store";
import { projectShiftStartSchema, shiftHostSnapshotSchema } from "./protocol";
import { projectShiftFlags, projectShiftRequestHash } from "./registry";

const word = z.string().min(1).max(1024);
const count = z.number().int().nonnegative();
const recordSchema = z
  .object({
    shiftId: word,
    workspace: word,
    pid: z
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1),
    state: z.enum(["running", "stopped"]),
    startedAt: z.iso.datetime(),
    deadline: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    reason: z.string().max(1000).optional(),
    options: z
      .object({
        concurrency: z
          .number()
          .int()
          .min(SHIFT_LIMITS.concurrency[0])
          .max(SHIFT_LIMITS.concurrency[1]),
        forMs: z
          .number()
          .int()
          .min(SHIFT_LIMITS.forMs[0])
          .max(SHIFT_LIMITS.forMs[1]),
        maxBeads: z
          .number()
          .int()
          .min(SHIFT_LIMITS.maxBeads[0])
          .max(SHIFT_LIMITS.maxBeads[1]),
        maxUsd: z.number().finite().positive().max(SHIFT_MAX_USD),
        repairs: z
          .number()
          .int()
          .min(SHIFT_LIMITS.repairs[0])
          .max(SHIFT_LIMITS.repairs[1]),
        throttle: z.number().finite().min(0.1).max(1).optional(),
        base: word,
        epic: word.optional(),
        smith: word.optional(),
        runTimeoutMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    spentUsd: z.number().finite().nonnegative(),
    unpriced: count,
    admitted: count.optional(),
    beads: z
      .array(
        z
          .object({ outcome: z.enum(SHIFT_BEAD_OUTCOMES), attempts: count })
          .passthrough(),
      )
      .max(10000),
  })
  .passthrough()
  .refine(
    (record) =>
      Date.parse(record.deadline) - Date.parse(record.startedAt) ===
        record.options.forMs &&
      (record.state !== "stopped" || record.endedAt !== undefined),
  );
const launchSchema = z
  .object({
    shiftId: word,
    workspace: word,
    state: z.enum(["starting", "failed"]),
    pid: z
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1),
    alive: z.boolean(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    requested: z.unknown(),
  })
  .passthrough();

/** Read-only correlation. A durable reservation or launch marker never proves a provider turn. */
export function observeProjectShift(
  intent: ProjectShiftIntent,
  source: {
    record?: unknown;
    launch?: unknown;
    alive?: boolean;
    stopRequested?: boolean;
  },
): ProjectShiftObservation {
  const base = { shiftId: intent.shiftId, requestId: intent.request.requestId };
  const unknown = (): ProjectShiftObservation => ({
    ...base,
    phase: "unknown",
    reason:
      "The original shift outcome could not be verified. Check this original request; it will not be launched again automatically.",
    actual: null,
  });
  if (source.record !== undefined && source.record !== null) {
    const checked = recordSchema.safeParse(source.record),
      expected = runOptions(projectShiftFlags(intent.request));
    if (!checked.success || !expected.ok) return unknown();
    const record = checked.data,
      options = record.options;
    if (
      record.shiftId !== intent.shiftId ||
      Date.parse(record.startedAt) < Date.parse(intent.createdAt) ||
      workspaceKey(record.workspace) !== workspaceKey(intent.workspace) ||
      options.concurrency !== intent.request.options.concurrency ||
      options.forMs !== expected.value.forMs ||
      options.maxBeads !== intent.request.options.maxBeads ||
      options.maxUsd !== intent.request.options.maxUsd ||
      options.repairs !== intent.request.options.repairs ||
      options.base !== intent.request.options.base ||
      options.epic !== intent.request.options.epic ||
      options.smith !== intent.request.options.smith ||
      options.runTimeoutMs !== expected.value.runTimeoutMs ||
      source.alive === undefined
    )
      return unknown();
    const sampled = shiftHostSnapshotSchema.safeParse(record["host"]);
    const host =
      sampled.success &&
      Date.parse(sampled.data.asOf) >= Date.parse(record.startedAt)
        ? sampled.data
        : null;
    const phase =
      record.state === "stopped"
        ? "stopped"
        : !source.alive
          ? "needs-recovery"
          : source.stopRequested === true
            ? "stopping"
            : host?.busy === true
              ? "throttled"
              : "running";
    const reason =
      phase === "needs-recovery"
        ? "The recorded shift process is no longer alive. Recover explicitly to settle the work it still owns."
        : phase === "stopping"
          ? "Stop was requested. Waiting for supervised runs to exit and settle their owned work."
          : phase === "stopped"
            ? (SHIFT_STOP_REASONS.find((known) => known === record.reason) ??
              "Stopped; the reason is unavailable.")
            : phase === "throttled"
              ? "Admission is paused while the measured host load is at or above the configured threshold. Running attempts retain their owned controls."
              : null;
    return {
      ...base,
      phase,
      reason,
      actual: {
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? null,
        deadline: record.deadline,
        concurrency: options.concurrency,
        forMs: options.forMs,
        maxBeads: options.maxBeads,
        maxUsd: options.maxUsd,
        repairs: options.repairs,
        throttle: options.throttle ?? null,
        base: options.base,
        epic: options.epic ?? null,
        smith: options.smith ?? null,
        runTimeoutMs: options.runTimeoutMs ?? null,
        spentUsd: record.spentUsd,
        unpriced: record.unpriced,
        admitted: record.admitted ?? null,
        reviewed: record.beads.filter((bead) => bead.outcome === "review")
          .length,
        running: record.beads.filter((bead) => bead.outcome === "running")
          .length,
        halted: record.beads.filter((bead) => bead.outcome === "halted").length,
        host,
      },
    };
  }
  if (intent.startupStop?.completedAt)
    return {
      ...base,
      phase: "stopped",
      reason:
        "Startup Stop is confirmed: the original held tree exited before a shift record was created.",
      actual: null,
    };
  if (source.launch !== undefined && source.launch !== null) {
    const checked = launchSchema.safeParse(source.launch);
    if (
      !checked.success ||
      checked.data.shiftId !== intent.shiftId ||
      workspaceKey(checked.data.workspace) !== workspaceKey(intent.workspace) ||
      Date.parse(checked.data.startedAt) < Date.parse(intent.createdAt) ||
      (checked.data.state === "starting" && !checked.data.alive) ||
      (checked.data.state === "failed" &&
        (checked.data.alive || checked.data.endedAt === undefined))
    )
      return unknown();
    if (intent.startupStop)
      return checked.data.alive
        ? {
            ...base,
            phase: "stopping",
            reason:
              "Startup Stop was requested. Waiting for the original held tree to exit.",
            actual: null,
          }
        : unknown();
    const requested = projectShiftStartSchema.safeParse({
      ...intent.request,
      options: checked.data.requested,
    });
    if (
      !requested.success ||
      projectShiftRequestHash(
        intent.projectId,
        intent.workspace,
        requested.data,
      ) !== intent.requestHash
    )
      return unknown();
    return {
      ...base,
      phase: checked.data.state,
      reason:
        checked.data.state === "failed"
          ? "The shift process ended before a verified shift record was observed. Check the original request."
          : "The supervised shift process is starting; no provider turn is established by this launch.",
      actual: null,
    };
  }
  return intent.attemptedAt === null
    ? {
        ...base,
        phase: "reserved",
        reason:
          "The original Start is retained; no corresponding launch was observed. Checking it never dispatches the shift.",
        actual: null,
      }
    : unknown();
}

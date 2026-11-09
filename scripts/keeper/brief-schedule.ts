import { z } from "zod";

if (typeof window !== "undefined") z.config({ jitless: true });
const off = z.object({ kind: z.literal("off") }).strict();
const daily = z
  .object({
    kind: z.literal("daily"),
    atUtc: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();
const supportedInstant = (value: number): boolean =>
  Number.isSafeInteger(value) && new Date(value).getTime() === value;
const activation = z.iso
  .datetime()
  .min(20)
  .max(24)
  .refine((value) => {
    const instant = Date.parse(value);
    return (
      supportedInstant(instant) &&
      new Date(instant).toISOString().slice(0, 10) === value.slice(0, 10)
    );
  }, "Expected a supported UTC activation instant.");

export const keeperScheduleInputSchema = z.discriminatedUnion("kind", [
  off,
  daily,
]);
export const keeperScheduleSavedSchema = z.discriminatedUnion("kind", [
  off,
  daily.extend({ generation: z.uuid(), activatedAt: activation }).strict(),
]);
export type KeeperScheduleInput = z.infer<typeof keeperScheduleInputSchema>;
export type KeeperScheduleSaved = z.infer<typeof keeperScheduleSavedSchema>;

const DAY_MS = 86_400_000;
function iso(instant: number): string {
  if (!supportedInstant(instant))
    throw new RangeError(
      "The scheduled UTC instant exceeds the supported date range.",
    );
  return new Date(instant).toISOString();
}

/** Calendar slots only; never reads sources, starts work or grants admission. */
export function keeperScheduleWindow(
  saved: unknown,
  nowMs: number,
): {
  latestDueAt: string | null;
  nextDueAt: string | null;
} {
  if (!supportedInstant(nowMs))
    throw new RangeError("Expected a supported integer current instant.");
  const schedule = keeperScheduleSavedSchema.parse(saved);
  if (schedule.kind === "off") return { latestDueAt: null, nextDueAt: null };
  const activatedAt = Date.parse(schedule.activatedAt);
  const offset =
    (Number(schedule.atUtc.slice(0, 2)) * 60 +
      Number(schedule.atUtc.slice(3))) *
    60_000;
  let latest = Math.floor(nowMs / DAY_MS) * DAY_MS + offset;
  if (latest > nowMs) latest -= DAY_MS;
  let next =
    Math.floor(Math.max(nowMs, activatedAt) / DAY_MS) * DAY_MS + offset;
  if (next <= nowMs || next < activatedAt) next += DAY_MS;
  return {
    latestDueAt: latest >= activatedAt ? iso(latest) : null,
    nextDueAt: iso(next),
  };
}

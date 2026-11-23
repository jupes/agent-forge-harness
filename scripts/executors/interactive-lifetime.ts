import { SHIFT_LIMITS } from "../config/defaults";

/** Trusted internal capabilities. Public session and shift requests never carry this discriminator. */
export type InteractiveLifetime = "shift-attempt" | "shift-engine";
export const SHIFT_ENGINE_GRACE_MS = 5 * 60_000;
export const DEFAULT_INTERACTIVE_LIFETIME_MS = 30 * 60_000;

/** One bound for the parent's timer and the child's private grant; reviewed work is never silently shortened. */
export function interactiveLifetimeMs(
  timeoutMs = DEFAULT_INTERACTIVE_LIFETIME_MS,
  lifetime?: InteractiveLifetime,
): number {
  const maximum =
    lifetime === "shift-attempt"
      ? SHIFT_LIMITS.forMs[1]
      : lifetime === "shift-engine"
        ? SHIFT_LIMITS.forMs[1] + SHIFT_ENGINE_GRACE_MS
        : DEFAULT_INTERACTIVE_LIFETIME_MS;
  if (
    (lifetime !== undefined &&
      lifetime !== "shift-attempt" &&
      lifetime !== "shift-engine") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maximum
  )
    throw Error("The owned process lifetime is outside its verified bounds.");
  return timeoutMs;
}

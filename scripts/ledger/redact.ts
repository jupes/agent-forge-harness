/**
 * Redaction applied to everything the ledger stores.
 */

import { redactSecrets } from "../secret-patterns";

/** Summaries are the only bodies the ledger stores; this is their size limit. */
export const SUMMARY_CAP = 2000;

/** A copy of `value` with every string leaf passed through the secret scanner. */
export function redactDeep<T>(value: T): T {
  // justification: each branch returns the same shape it was given, with strings replaced by strings.
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = redactDeep(item);
    return out as T;
  }
  return value;
}

/**
 * Cut a redacted payload's `summary` to the cap. Runs after redaction, so a
 * secret is never split into a shape the scanner would no longer recognise.
 */
export function capSummary(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const summary = payload.summary;
  if (typeof summary !== "string" || summary.length <= SUMMARY_CAP)
    return payload;
  return { ...payload, summary: summary.slice(0, SUMMARY_CAP) };
}

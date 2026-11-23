const DURATION = /^([1-9]\d{0,5})(s|m|h)$/;
export const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Canonical whole CLI duration parsing, without config files or runtime imports. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  return (
    Number(match[1]) *
    DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS]
  );
}

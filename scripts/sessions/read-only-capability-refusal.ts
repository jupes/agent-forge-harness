const refusals = new WeakSet<object>();

/** Marks only a failed, read-only executable capability probe. */
export function markReadOnlyCapabilityRefusal<T extends Error>(error: T): T {
  refusals.add(error);
  return error;
}

export function isReadOnlyCapabilityRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && refusals.has(error);
}

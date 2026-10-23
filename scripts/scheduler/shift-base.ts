const BRANCH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Canonical shift base branch policy; pure so the reviewed browser bounds use the same rule. */
export function isBaseBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  if (value === "HEAD" || value.startsWith("shift/")) return false;
  if (value.includes("..") || value.endsWith(".lock")) return false;
  return value.split("/").every((part) => BRANCH_PART.test(part));
}

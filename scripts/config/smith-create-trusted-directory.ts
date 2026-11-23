import { canonicalTrustedDirectory } from "../trusted-directory";

/** Resolve trusted directory spelling aliases without following linked parents. */
export function canonicalSmithCreateDirectory(path: string): string {
  return canonicalTrustedDirectory(path);
}

import { createHash } from "node:crypto";
import type { BeadsIssue } from "../../types/beads";
import { selectProjectBeads } from "./scope";

/** Null means a requested epic is absent; callers retain their existing status. */
export function scopeMembershipProof(
  slug: string,
  workspace: string,
  epicIds: readonly string[],
  issues: readonly BeadsIssue[],
) {
  if (
    epicIds.some(
      (id) => !issues.some((issue) => issue.id === id && issue.type === "epic"),
    )
  )
    return null;
  const members = selectProjectBeads(
    {
      slug,
      workspaces: [
        { root: workspace, repositories: [], epicIds: [...epicIds] },
      ],
    },
    workspace,
    issues,
  )
    .map((issue) => issue.id)
    .sort();
  const proof = JSON.stringify({
    workspace,
    slug,
    epicIds: [...epicIds].sort(),
    members,
  });
  return {
    hash: createHash("sha256").update(proof).digest("hex"),
    count: members.length,
  };
}

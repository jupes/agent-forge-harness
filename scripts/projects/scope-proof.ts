import { createHash } from "node:crypto";
import type { BeadsIssue } from "../../types/beads";
import { selectProjectAnchors, selectProjectBeads } from "./scope";

/** Null means a requested epic is absent; callers retain their existing status. */
export function scopeMembershipProof(
  slug: string,
  workspace: string,
  epicIds: readonly string[],
  issues: readonly BeadsIssue[],
) {
  const project = {
    slug,
    workspaces: [{ root: workspace, repositories: [], epicIds: [...epicIds] }],
  };
  const anchors = new Set(
    selectProjectAnchors(project, workspace, issues).map((row) => row.id),
  );
  if (epicIds.some((id) => !anchors.has(id))) return null;
  const members = selectProjectBeads(project, workspace, issues)
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

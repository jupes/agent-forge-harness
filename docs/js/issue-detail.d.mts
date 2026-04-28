import type { BeadsComment, BeadsDependency } from "../../types/beads";

export function escapeHtml(str: unknown): string;
export function issueIdCopyControlHtml(issueId: unknown): string;
export function toggleExpandedState(
  currentExpandedId: string | null,
  clickedIssueId: string,
): string | null;
export function commentsForIssue(
  issueId: string,
  comments: unknown[] | undefined,
): BeadsComment[];
export function depsTouchingIssue(
  issueId: string,
  deps: unknown[] | undefined,
): BeadsDependency[];
export function workBranchesFromCommentBodies(
  comments: Array<{ body?: string }>,
): string[];
export function buildIssueDetailPanelHtml(
  issue: Record<string, unknown>,
  ctx: { comments?: unknown[]; deps?: unknown[] },
): string;

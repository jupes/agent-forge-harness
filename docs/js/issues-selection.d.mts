import type { BeadsIssue } from "../../types/beads";

export function listEpics(issues: BeadsIssue[] | undefined): BeadsIssue[];
export function computeInitiativeMembers(
  issues: BeadsIssue[] | undefined,
  epicId: string,
): Set<string>;
export function applyInitiativeFilter<T extends { id: string }>(
  issues: T[] | undefined,
  initiativeFilter: string,
): T[];
export function issuesInProgress(
  issues: BeadsIssue[] | undefined,
): BeadsIssue[];
export function sortByUpdatedDesc(a: BeadsIssue, b: BeadsIssue): number;
export function formatIssueDate(iso: unknown): string;

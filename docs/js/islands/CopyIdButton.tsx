import type { JSX } from "preact";

export interface CopyIdButtonProps {
  issueId: string;
}

/**
 * Copy an issue id to the clipboard.
 *
 * Carries the same `.issue-id-copy` class and `data-copy-text` attribute the
 * legacy HTML-string control used, so the delegated handler in
 * `copy-to-clipboard.ts` serves both while the migration is in flight.
 */
export function CopyIdButton({
  issueId,
}: CopyIdButtonProps): JSX.Element | null {
  if (!issueId) return null;
  return (
    <button
      type="button"
      class="issue-id-copy"
      data-copy-text={issueId}
      title="Copy issue ID"
    >
      <code>{issueId}</code>
    </button>
  );
}

/** Ambient types for browser `.mjs` imported from Bun tests via `@docs/bead-builder`. */
declare module "@docs/bead-builder" {
  export interface BeadBuilderFormData {
    title: string;
    type: string;
    priority: string;
    /** `.` for this checkout, or a sub-repo, named at the start of the title. */
    repo: string;
    description: string;
    acceptanceCriteria: string;
    labels: string;
    /** The id of the parent bead, when the new one is its child. */
    parent?: string | undefined;
  }

  export const BEAD_TYPES: readonly string[];
  export const BEAD_PRIORITIES: readonly string[];

  /** The acceptance criteria as one text: a line each, trimmed, blank lines dropped. */
  export function acceptanceText(lines: string): string;
  /** The title as filed by Create and by the copied command: a sub-repo named first, once. */
  export function titleWithRepo(
    title: string | undefined,
    repo: string | undefined,
  ): string;
  export function buildBdCreateCommand(data: BeadBuilderFormData): string;
}

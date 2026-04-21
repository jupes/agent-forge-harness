/** Ambient types for browser `.mjs` imported from Bun tests via `@docs/bead-builder`. */
declare module "@docs/bead-builder" {
  export interface BeadBuilderFormData {
    title: string;
    type: string;
    priority: string;
    repo: string;
    description: string;
    acceptanceCriteria: string;
    labels: string;
  }

  export const BEAD_TYPES: readonly string[];
  export const BEAD_PRIORITIES: readonly string[];

  export function buildBdCreateCommand(data: BeadBuilderFormData): string;
}

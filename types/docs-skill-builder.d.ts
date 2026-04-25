/** Ambient types for browser `.mjs` imported from Bun tests via `@docs/skill-builder`. */
declare module "@docs/skill-builder" {
  export interface SkillBuilderFormData {
    skillName: string;
    description: string;
    whenToUse: string;
    workflow: string;
    additionalNotes: string;
  }

  export function folderNameForSkill(raw: string): string;
  export function buildAuthoringPrompt(data: SkillBuilderFormData): string;
}

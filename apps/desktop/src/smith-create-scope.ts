/** Browser identity is scoped to the trusted workspace reported by the hearth. */
export function smithCreateMetadataScope(
  workspace: string | null,
): string | null {
  return workspace !== null && workspace.length > 0 && workspace.length <= 512
    ? workspace
    : null;
}

/** Browser identity is scoped to the trusted workspace reported by the hearth. */
export function smithCreateMetadataScope(
  workspace: string | null,
): string | null {
  return workspace !== null && workspace.length > 0 && workspace.length <= 512
    ? workspace
    : null;
}

/** A retired workspace client loses write authority before its cleanup effect runs. */
export function smithCreateScopeAllowsWrite(
  writesAllowed: boolean,
  currentScope: string | null,
  clientScope: string,
): boolean {
  return writesAllowed && currentScope === clientScope;
}

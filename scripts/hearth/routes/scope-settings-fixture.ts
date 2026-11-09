import { scopeSaveSchema } from "../../projects/scope-settings-protocol";

/** TEST ONLY. Schema-valid metadata reaches the audit gate without reading a source. */
export function inertScopeAuditFixture(requestId: string) {
  const id = "90000000-0000-4000-8000-000000000046";
  return scopeSaveSchema.parse({
    requestId,
    expectedRevision: 1,
    controllerId: id,
    workspaces: [
      {
        workspaceRef: "a".repeat(64),
        epicIds: ["alpha-epic"],
        grantId: id,
        sourceInstanceId: id,
        trackerId: id,
        scopeCount: 0,
        scopeHash: "a".repeat(64),
      },
    ],
  });
}

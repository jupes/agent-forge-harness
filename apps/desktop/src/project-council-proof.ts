import type { CouncilRun } from "../../../scripts/council/types";
import {
  type ProjectCouncilOriginalRead,
  projectCouncilIntentJson,
  projectCouncilOriginalReadSchema,
} from "../../../types/project-council";
import type { ProjectCouncilRunRead } from "../../../types/project-council-run-read";

export function publishedContextMatches(
  published: NonNullable<
    NonNullable<ProjectCouncilRunRead["job"]>["run"]
  >["context"],
  original: ProjectCouncilOriginalRead["original"]["context"],
): boolean {
  const expected = {
    source: original.source,
    contentHash: original.contentHash,
    byteLength: original.byteLength,
    truncated: original.truncated,
    redactions: original.redactions,
    evidence: original.evidence,
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return canonical(published) === canonical(expected);
}

export async function verifyProjectCouncilOriginalRead(
  value: unknown,
  projectId: string,
  workspace: string | null,
  requestId?: string,
): Promise<ProjectCouncilOriginalRead> {
  const result = projectCouncilOriginalReadSchema.parse(value);
  const { metadata, original } = result;
  if (
    metadata.projectId !== projectId ||
    original.binding.projectId !== projectId ||
    workspace === null ||
    original.binding.workspace !== workspace ||
    (requestId !== undefined && original.requestId !== requestId) ||
    metadata.requestId !== original.requestId ||
    metadata.intentHash !== original.intentHash
  )
    throw Error(
      "The saved original belongs to a different project or workspace.",
    );
  const expected = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(projectCouncilIntentJson(original)),
  );
  const hash = [...new Uint8Array(expected)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== original.intentHash)
    throw Error(
      "The saved original hash does not match its reviewed contents.",
    );
  return result;
}

/** Public JSON optional fields are omitted before using canonical domain types. */
export function councilVerdictInput(
  run: NonNullable<NonNullable<ProjectCouncilRunRead["job"]>["run"]>,
): Pick<CouncilRun, "status" | "chair" | "aggregatedFindings"> {
  return {
    status: run.status,
    ...(run.chair === undefined ? {} : { chair: run.chair }),
    aggregatedFindings: run.aggregatedFindings.map((finding) => ({
      ...finding,
      rationales: finding.rationales.map(
        ({ suggestedSeverity, ...rationale }) => ({
          ...rationale,
          ...(suggestedSeverity === undefined ? {} : { suggestedSeverity }),
        }),
      ),
    })),
  };
}

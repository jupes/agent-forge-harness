export type AttestationValue = "yes" | "no";
export type CloseGateIssueType = "epic" | "feature" | "task" | "bug" | "chore" | "unknown";

export type ParsedTestingAttestation = {
  automation: AttestationValue;
  unit: AttestationValue;
};

export type CloseTestingAttestationResult = {
  required: boolean;
  passed: boolean;
  guidance: string | null;
};

const tokenRe = /\b([a-z_]+)\s*=\s*(yes|no)\b/gi;

export function parseTestingAttestationFromComment(body: string): ParsedTestingAttestation | null {
  if (!/\btesting-attestation\b/i.test(body)) return null;
  const values: Partial<ParsedTestingAttestation> = {};
  for (const m of body.matchAll(tokenRe)) {
    const key = (m[1] ?? "").toLowerCase();
    const val = (m[2] ?? "").toLowerCase() as AttestationValue;
    if (key === "automation" || key === "unit") {
      values[key] = val;
    }
  }
  if (!values.automation || !values.unit) return null;
  return { automation: values.automation, unit: values.unit };
}

function requiresTestingAttestation(issueType: CloseGateIssueType): boolean {
  return issueType === "feature" || issueType === "epic";
}

function guidanceText(): string {
  return [
    "Feature/epic close requires testing attestation.",
    "Add a Beads comment then retry completion:",
    'bd comments add <TASK-ID> "worklog: testing-attestation automation=yes|no unit=yes|no notes=<short context>"',
  ].join(" ");
}

export function evaluateCloseTestingAttestation(
  issueType: CloseGateIssueType,
  commentBodies: string[],
): CloseTestingAttestationResult {
  if (!requiresTestingAttestation(issueType)) {
    return { required: false, passed: true, guidance: null };
  }
  for (let i = commentBodies.length - 1; i >= 0; i -= 1) {
    const parsed = parseTestingAttestationFromComment(commentBodies[i] ?? "");
    if (parsed) return { required: true, passed: true, guidance: null };
  }
  return { required: true, passed: false, guidance: guidanceText() };
}

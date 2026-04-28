import { describe, expect, test } from "bun:test";
import {
  evaluateCloseTestingAttestation,
  parseTestingAttestationFromComment,
  type CloseGateIssueType,
} from "./close-testing-attestation";

describe("parseTestingAttestationFromComment", () => {
  test("parses explicit automation/unit yes values", () => {
    const got = parseTestingAttestationFromComment(
      "worklog: testing-attestation automation=yes unit=yes notes=added dashboard tests",
    );
    expect(got).toEqual({ automation: "yes", unit: "yes" });
  });

  test("parses explicit automation/unit no values", () => {
    const got = parseTestingAttestationFromComment(
      "review: testing-attestation automation=no unit=no notes=docs-only",
    );
    expect(got).toEqual({ automation: "no", unit: "no" });
  });

  test("returns null when attestation marker missing", () => {
    expect(parseTestingAttestationFromComment("worklog: regular progress update")).toBeNull();
  });
});

describe("evaluateCloseTestingAttestation", () => {
  test("skips non feature/epic issue types", () => {
    const issueType: CloseGateIssueType = "task";
    const got = evaluateCloseTestingAttestation(issueType, []);
    expect(got.required).toBe(false);
    expect(got.passed).toBe(true);
  });

  test("requires attestation for feature and epic", () => {
    const feature = evaluateCloseTestingAttestation("feature", []);
    const epic = evaluateCloseTestingAttestation("epic", []);
    expect(feature.required).toBe(true);
    expect(feature.passed).toBe(false);
    expect(epic.required).toBe(true);
    expect(epic.passed).toBe(false);
  });

  test("passes when latest comment includes valid attestation", () => {
    const got = evaluateCloseTestingAttestation("feature", [
      "worklog: prep changes",
      "worklog: testing-attestation automation=yes unit=no notes=integration only",
    ]);
    expect(got.passed).toBe(true);
  });

  test("returns remediation guidance when missing", () => {
    const got = evaluateCloseTestingAttestation("feature", []);
    expect(got.passed).toBe(false);
    expect(got.guidance).toContain("bd comments add <TASK-ID>");
    expect(got.guidance).toContain("testing-attestation automation=");
    expect(got.guidance).toContain("unit=");
  });
});

import { expect, test } from "bun:test";
import { KEEPER_PROPOSAL_GUIDE, keeperProposalGuide } from "./proposal-guide";

test("Suggest-only instructions ask for recommendations without action cards", () => {
  expect(keeperProposalGuide("suggest-only")).toContain("Suggest only");
  expect(keeperProposalGuide("suggest-only")).toContain(
    "Do not emit actionable proposal JSON",
  );
  expect(keeperProposalGuide("suggest-only")).not.toContain("Schema:");
  expect(keeperProposalGuide(undefined)).toBe(KEEPER_PROPOSAL_GUIDE);
  expect(keeperProposalGuide("propose-for-approval")).toBe(
    KEEPER_PROPOSAL_GUIDE,
  );
});

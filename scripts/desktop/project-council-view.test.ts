import { describe, expect, test } from "bun:test";
import { projectCouncilProgressView } from "../../apps/desktop/src/ProjectReviews";

const started = { type: "run.started", payload: {} };
const stage = (name: string, round?: number) => ({
  type: "stage.started",
  payload: { stage: name, ...(round === undefined ? {} : { round }) },
});
const job = (status: string, ...events: { type: string; payload?: { stage?: string; round?: number } }[]) => ({
  status,
  events,
});

describe("Project Council progress presentation", () => {
  test("shows Queued only for a verified running receipt before the first stage", () => {
    expect(projectCouncilProgressView("running", job("running", started))).toEqual({
      active: true,
      label: "Queued",
      stopPending: false,
    });
    expect(projectCouncilProgressView("running", job("running"))).toMatchObject({
      label: "Checking saved progress",
    });
    expect(projectCouncilProgressView("unknown", job("running", started))).toMatchObject({
      active: false,
      label: null,
    });
  });

  test("uses only the verified started stage to describe progress", () => {
    expect(projectCouncilProgressView("running", job("running", started, stage("independent"))).label).toBe("Reviewing");
    expect(projectCouncilProgressView("running", job("running", started, stage("peer", 2))).label).toBe("Discussing round 2");
    expect(projectCouncilProgressView("running", job("running", started, stage("revision", 3))).label).toBe("Discussing round 3");
    expect(projectCouncilProgressView("running", job("running", started, stage("chair"))).label).toBe("Synthesizing");
  });

  test("keeps a cancelling job active while disabling repeat Stop", () => {
    expect(projectCouncilProgressView("running", job("cancelling", started))).toEqual({
      active: true,
      label: "Stop requested; waiting for a verified saved result",
      stopPending: true,
    });
  });
});

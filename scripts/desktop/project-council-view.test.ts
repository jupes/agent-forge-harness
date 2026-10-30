import { describe, expect, test } from "bun:test";
import {
  projectCouncilLiveReviewView,
  projectCouncilProgressView,
} from "../../apps/desktop/src/ProjectReviews";

const started = { type: "run.started", payload: {} };
const stage = (name: string, round?: number) => ({
  type: "stage.started",
  payload: { stage: name, ...(round === undefined ? {} : { round }) },
});
const job = (
  status: string,
  ...events: { type: string; payload?: { stage?: string; round?: number } }[]
) => ({
  status,
  events,
});

describe("Project Council progress presentation", () => {
  test("shows Queued only for a verified running receipt before the first stage", () => {
    expect(
      projectCouncilProgressView("running", job("running", started)),
    ).toEqual({
      active: true,
      label: "Queued",
      stopPending: false,
    });
    expect(projectCouncilProgressView("running", job("running"))).toMatchObject(
      {
        label: "Checking saved progress",
      },
    );
    expect(
      projectCouncilProgressView("unknown", job("running", started)),
    ).toMatchObject({
      active: false,
      label: null,
    });
  });

  test("uses only the verified started stage to describe progress", () => {
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("independent")),
      ).label,
    ).toBe("Reviewing");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("peer", 2)),
      ).label,
    ).toBe("Discussing round 2");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("peer", 0)),
      ).label,
    ).toBe("Discussing round 0");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("peer")),
      ).label,
    ).toBe("Discussing (number not recorded)");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("revision", 3)),
      ).label,
    ).toBe("Discussing round 3");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("chair")),
      ).label,
    ).toBe("Synthesizing");
    expect(
      projectCouncilProgressView(
        "running",
        job("running", started, stage("unexpected")),
      ).label,
    ).toBe("Checking saved progress");
  });

  test("keeps a cancelling job active while disabling repeat Stop", () => {
    expect(
      projectCouncilProgressView("running", job("cancelling", started)),
    ).toEqual({
      active: true,
      label: "Stop requested; waiting for a verified saved result",
      stopPending: true,
    });
  });
});

describe("Project Council live review presentation", () => {
  const roster = [
    { id: "independent", role: "Independent reviewer" },
    { id: "peer", role: "Peer reviewer" },
    { id: "revision", role: "Revision reviewer" },
    { id: "failed", role: "Failure reviewer" },
    { id: "retry", role: "Retry reviewer" },
    { id: "cancelled", role: "Cancelled reviewer" },
    { id: "chair", role: "Chair" },
  ];

  test("prefers live rounds and overlays exact saved seat events on the full pending roster", () => {
    const liveRounds = [{ stage: "peer", round: 0 }];
    const savedRounds = [{ stage: "revision", round: 1 }];
    const events = [
      { type: "stage.started", payload: { stage: "independent" } },
      {
        type: "seat.started",
        payload: { stage: "independent", seatId: "independent" },
      },
      {
        type: "seat.completed",
        payload: { stage: "independent", seatId: "independent" },
      },
      { type: "stage.completed", payload: { stage: "independent" } },
      { type: "stage.started", payload: { stage: "peer", round: 0 } },
      { type: "seat.started", payload: { stage: "peer", seatId: "peer" } },
      { type: "stage.completed", payload: { stage: "peer", round: 0 } },
      { type: "stage.started", payload: { stage: "revision", round: 1 } },
      {
        type: "seat.started",
        payload: { stage: "revision", seatId: "revision" },
      },
      { type: "seat.failed", payload: { stage: "revision", seatId: "failed" } },
      { type: "seat.failed", payload: { stage: "revision", seatId: "retry" } },
      { type: "seat.started", payload: { stage: "revision", seatId: "retry" } },
      {
        type: "seat.cancelled",
        payload: { stage: "revision", seatId: "cancelled" },
      },
      { type: "stage.started", payload: { stage: "chair" } },
      { type: "seat.started", payload: { stage: "chair", seatId: "chair" } },
      { type: "seat.started", payload: { stage: "peer", seatId: "unlisted" } },
    ];
    const view = projectCouncilLiveReviewView(
      liveRounds,
      savedRounds,
      roster,
      [{ id: "other", role: "Other profile" }],
      events,
    );
    const revisionView = projectCouncilLiveReviewView(
      liveRounds,
      savedRounds,
      roster,
      undefined,
      events.slice(0, 12),
    );
    expect(view.rounds).toBe(liveRounds);
    expect(
      revisionView.seats.find((seat) => seat.seatId === "peer")?.state,
    ).toBe("Pending");
    expect(
      revisionView.seats.find((seat) => seat.seatId === "revision")?.state,
    ).toBe("Discussing round 1");
    expect(
      revisionView.seats.find((seat) => seat.seatId === "retry")?.state,
    ).toBe("Discussing round 1");
    expect(view.seats).toEqual([
      { seatId: "independent", role: "Independent reviewer", state: "Pending" },
      { seatId: "peer", role: "Peer reviewer", state: "Pending" },
      { seatId: "revision", role: "Revision reviewer", state: "Pending" },
      { seatId: "failed", role: "Failure reviewer", state: "Failed" },
      { seatId: "retry", role: "Retry reviewer", state: "Pending" },
      { seatId: "cancelled", role: "Cancelled reviewer", state: "Cancelled" },
      { seatId: "chair", role: "Chair", state: "Synthesizing" },
    ]);
  });

  test("falls back to saved rounds and original roster; missing rounds and profiles stay explicit", () => {
    const savedRounds = [{ stage: "peer", round: 0 }];
    const fallback = projectCouncilLiveReviewView(
      undefined,
      savedRounds,
      undefined,
      [{ id: "peer", role: "Peer reviewer" }],
      [
        { type: "stage.started", payload: { stage: "revision" } },
        {
          type: "seat.started",
          payload: { stage: "revision", seatId: "peer" },
        },
      ],
    );
    expect(fallback.rounds).toBe(savedRounds);
    expect(fallback.seats).toEqual([
      {
        seatId: "peer",
        role: "Peer reviewer",
        state: "Discussing (number not recorded)",
      },
    ]);
    const unknown = projectCouncilLiveReviewView(
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(unknown).toEqual({ rounds: [], rosterKnown: false, seats: [] });
  });
});

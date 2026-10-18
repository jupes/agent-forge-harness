import { expect, test } from "bun:test";
import {
  verdictBead,
  verdictStatus,
} from "../../docs/js/islands/CouncilVerdictStatus";
import type { EventsPage, LedgerEvent } from "../../types/hearth";
import type { CouncilServiceJob } from "../council/service";

// justification: the projection reads only status, source, id and start time.
const job = {
  runId: "review-1",
  startedAt: "2026-10-17T00:00:00Z",
  status: "completed",
  run: {
    status: "completed",
    context: { source: { kind: "bead", locator: "demo-7" } },
  },
} as unknown as CouncilServiceJob;
const event = {
  id: 1,
  ulid: "01J0AAAAAAAAAAAAAAAAAAAAAA",
  kind: "council.verdict.comment",
  ts: "2026-10-17T00:00:01Z",
  workspace: "/workspace",
  beadId: "demo-7",
  payload: { councilRunId: "review-1", status: "posted" },
} satisfies LedgerEvent;
const page = (...events: LedgerEvent[]): EventsPage => ({
  events,
  cursor: 1,
  more: false,
});

test("only completed bead sources use the stored locator", () => {
  expect(verdictBead(job)).toBe("demo-7");
  for (const status of ["running", "cancelled", "failed"] as const)
    expect(verdictBead({ ...job, status })).toBeNull();
  for (const source of [
    { kind: "text", locator: "demo-7" },
    { kind: "bead", locator: "--help" },
    { kind: "bead", locator: "" },
  ]) {
    // justification: malformed stored sources exercise the browser's conservative projection.
    expect(
      verdictBead({
        ...job,
        run: { ...job.run, context: { source } },
      } as unknown as CouncilServiceJob),
    ).toBeNull();
  }
});

test("each recorded outcome survives projection, including an unknown write", () => {
  for (const status of ["posted", "refused", "unknown"] as const)
    expect(
      verdictStatus(
        job,
        page({ ...event, payload: { ...event.payload, status } }),
      ),
    ).toBe(status);
});

test("absence, malformed reads, truncation and conflicting duplicate outcomes stay unknown", () => {
  for (const data of [
    null,
    page(),
    { ...page(), more: true },
    { events: null } as unknown as EventsPage,
  ])
    expect(verdictStatus(job, data)).toBe("unknown");
  expect(
    verdictStatus(
      job,
      page(event, {
        ...event,
        payload: { ...event.payload, status: "refused" },
      }),
    ),
  ).toBe("unknown");
  expect(
    verdictStatus(
      job,
      page({
        ...event,
        payload: { ...event.payload, status: "probably" },
      } as unknown as LedgerEvent),
    ),
  ).toBe("unknown");
});

test("other run, prefix bead, missing or old timestamp never confirm this job", () => {
  for (const other of [
    { ...event, beadId: "demo-7.1" },
    { ...event, beadId: "demo-8" },
    { ...event, payload: { ...event.payload, councilRunId: "review-2" } },
    { ...event, ts: "2026-10-16T23:59:59Z" },
    { ...event, ts: "bad" },
  ])
    expect(verdictStatus(job, page(other))).toBe("unknown");
  expect(verdictStatus({ ...job, runId: "review-2" }, page(event))).toBe(
    "unknown",
  );
});

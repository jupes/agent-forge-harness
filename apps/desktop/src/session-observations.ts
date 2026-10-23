import type { SessionSummary } from "../../../types/hearth";
import type {
  ProjectSessionObservations,
  SessionOwnershipMetadata,
} from "../../../types/session-observations";
import type { FrameSessionStatus } from "./DesktopFrame";
import { sessionRows } from "./sessions-model";

export interface SessionObservationRow {
  id: string;
  title: string;
  provider: string;
  status: FrameSessionStatus;
  depth: number;
  ownership: "owned" | "external" | "unavailable";
  reason: string;
  owner: SessionOwnershipMetadata | null;
  observation: SessionSummary | null;
}

/** Historical ownership and current process-control availability are independent facts. */
export function sessionObservationRows(
  index: ProjectSessionObservations,
  retained: readonly SessionOwnershipMetadata[] = [],
): SessionObservationRow[] {
  const owners = new Map<string, SessionOwnershipMetadata>();
  for (const owner of [...retained, ...index.ownership.records])
    if (
      owner.record.projectId === index.projectId &&
      owner.record.workspace === index.workspace
    )
      owners.set(owner.record.id, owner);
  const observed = sessionRows(index.observations, {}, index.asOf);
  const currentIds = new Set(
    index.ownership.records.map((owner) => owner.record.id),
  );
  const rows: SessionObservationRow[] = [...owners.values()]
    .sort(
      (a, b) =>
        Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt) ||
        a.record.id.localeCompare(b.record.id),
    )
    .map((owner) => ({
      id: owner.record.id,
      title: `${owner.origin ? "Shift" : owner.record.mode === "chat" ? "Chat" : "Task"} · ${owner.record.beadId ?? owner.record.requestedModel}`,
      provider: owner.record.provider,
      status: "unverified",
      depth:
        observed.find((row) => row.session.sessionId === owner.record.id)
          ?.depth ?? 0,
      ownership: "owned",
      reason: !index.ownership.available
        ? `Previously verified app-owned session. ${index.ownership.reason}`
        : !currentIds.has(owner.record.id)
          ? "Previously verified app-owned session; it is absent from the current registry read. Open it to check saved history."
          : owner.origin
            ? "Started by a shift. Its conversation and controls are unavailable in this view."
            : "App-owned session. Open it to check saved status and available controls.",
      owner,
      observation:
        observed.find((row) => row.session.sessionId === owner.record.id)
          ?.session ?? null,
    }));
  for (const row of observed) {
    if (owners.has(row.session.sessionId)) continue;
    const external =
      index.ownership.available &&
      row.session.kind !== undefined &&
      row.session.kind !== "headless";
    rows.push({
      id: row.session.sessionId,
      title: row.session.beadId ?? row.session.sessionId,
      provider: row.session.executor?.provider ?? "Provider not reported",
      status: external ? row.group : "unverified",
      depth: row.depth,
      ownership: external ? "external" : "unavailable",
      reason: !index.ownership.available
        ? index.ownership.reason
        : row.session.kind === "headless"
          ? "Headless activity was recorded, but its origin is unavailable. No private transcript or control is authorized."
          : row.session.kind === undefined
            ? "Session origin was not reported. Check the session metadata; ownership is unavailable."
            : "Observed activity only. The conversation is not captured here.",
      owner: null,
      observation: row.session,
    });
  }
  return rows;
}

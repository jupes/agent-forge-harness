import type { JSX } from "preact";
import type { CouncilServiceJob } from "../../../scripts/council/service";
import type { CouncilSeat } from "../../../scripts/council/types";
import { Card } from "../ds/Card";

function seatPhase(job: CouncilServiceJob | null, seat: CouncilSeat): string {
  const event = job?.events
    .filter((item) => item.payload.seatId === seat.id)
    .at(-1);
  if (!event)
    return job?.status === "running" || job?.status === "cancelling"
      ? "Waiting"
      : "Ready";
  const stage = String(event.payload.stage ?? "review");
  if (event.type === "seat.failed") return `${stage} · failed`;
  if (event.type === "seat.cancelled") return `${stage} · cancelled`;
  if (event.type === "seat.completed") return `${stage} · complete`;
  return `${stage} · reviewing`;
}

export function CouncilMembers({
  job,
  roster,
}: {
  job: CouncilServiceJob | null;
  roster: CouncilSeat[];
}): JSX.Element {
  return (
    <Card
      title="Seats"
      headingLevel={2}
      kicker={
        job ? "members for the selected run" : "members for the next review"
      }
    >
      <div class="af-seat-grid">
        {roster.map((seat) => (
          <article class="af-seat" key={seat.id}>
            <h3 class="af-seat-id">{seat.id}</h3>
            <p class="af-seat-model">
              {seat.provider} / {seat.model}
            </p>
            <p class="af-seat-model">{seat.role}</p>
            <p class="af-seat-phase">{seatPhase(job, seat)}</p>
          </article>
        ))}
      </div>
    </Card>
  );
}

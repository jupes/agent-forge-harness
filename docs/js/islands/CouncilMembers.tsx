import type { CouncilServiceJob } from "../../../scripts/council/service";
import type { CouncilSeat } from "../../../scripts/council/types";

function seatPhase(job: CouncilServiceJob | null, seat: CouncilSeat): string {
  const event = job?.events
    .filter((item) => item.payload.seatId === seat.id)
    .at(-1);
  if (!event) return job?.status === "running" ? "Waiting" : "Ready";
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
}) {
  return (
    <section aria-label="Council members">
      <p className="muted">
        {job ? "Members for the selected run" : "Members for the next review"}
      </p>
      <div className="seat-grid">
        {roster.map((seat) => (
          <article className="seat" key={seat.id}>
            <h3>{seat.id}</h3>
            <p className="model">
              {seat.provider} / {seat.model}
            </p>
            <p className="model">{seat.role}</p>
            <p className="phase">{seatPhase(job, seat)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

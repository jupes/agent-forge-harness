/**
 * Which queued beads may start now: ready, queued, not touching files
 * another bead has reserved or a bead before it in bundle order claims, and
 * the host not too busy.
 *
 * `eligibility` is pure. Candidates are walked in three groups: beads in
 * progress (running: they claim their current map before any other check),
 * then beads that hold a reservation (they have, in effect, started), then
 * the rest. Within each group the order is the bundle order: the layers of
 * `planBundles` over `blocks`/`requires` edges, then priority, then id in
 * natural order (`x.2` before `x.10`). Each bead that could run or is running
 * claims its file map as it is passed, eligible or waiting, so a later bead
 * that overlaps it waits behind it, and since a bead is checked only against
 * claims made before it, no two beads wait on each other. What a bead holds
 * always claims. A blocked bead (not ready and not in progress) claims
 * nothing more, so it never holds back the bead that unblocks it.
 *
 * A queued bead that still holds a reservation in a shift's worktree
 * (`<main>/trees/<shift-id>-<n>`) whose shift has not stopped waits for that
 * reservation to be released: its earlier run there may still be running
 * (it was paused and resumed before that shift noticed), and a second start
 * would run it twice (`x1gs.5.4.13`). A shift releases a run's reservation
 * only once the run has ended. A reservation made outside any shift does not
 * hold its bead back.
 *
 * `readEligibility` fills the input from `bd`, the ledger and the shift
 * records, and writes nothing.
 */

import { join } from "node:path";
import type { BeadsDependency, BeadsIssue } from "../../types/beads";
import type { Reservation } from "../../types/hearth";
import { planBundles } from "../beads/convoy-bundles-core";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { parsed, refusal } from "../hearth/tracker-write";
import { activeReservations } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { pickableRow, QUEUED_EXACT_ARGS } from "./queue";
import {
  type BeadReservation,
  overlapOf,
  reservationFor,
} from "./reservations";
import {
  type ShiftStanding,
  shiftOfWorktree,
  shiftStanding,
} from "./shift-store";
import { comparablePath } from "./worktrees";

/** A queued bead as `bd list --json` prints it (the fields read here). */
export interface QueuedBead {
  id: string;
  title?: string;
  issue_type?: string;
  status: string;
  priority?: number;
  description?: string;
  acceptance_criteria?: string;
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
  }>;
  /** Read only to drop a bead the queue would refuse (`pickableRow`). */
  labels?: unknown;
  metadata?: unknown;
}

export type StaleWhy = "closed" | "gone";

/** The shift a reservation's worktree was made for, and how that shift stands. */
export interface ShiftWorktree {
  shiftId: string;
  standing: ShiftStanding;
}

export interface EligibilityInput {
  /** The beads in `queued`, by the queue's own writing. */
  candidates: readonly QueuedBead[];
  /** Which of them `bd` calls ready (no open blocker, not in progress). */
  readyIds: ReadonlySet<string>;
  /** The reservations the ledger holds. */
  active: readonly Reservation[];
  /** Reserved beads that are closed, or no longer exist: their reservations are ignored. */
  staleIds: ReadonlyMap<string, StaleWhy>;
  host: { busy: boolean; reason?: string };
  /**
   * By a reservation's `worktree` as `active` holds it: the shift that
   * worktree was made for (`<main>/trees/<shift-id>-<n>`). A worktree not
   * listed was made outside any shift; absent, none was.
   */
  shiftWorktrees?: ReadonlyMap<string, ShiftWorktree>;
}

export interface Eligible extends BeadReservation {
  id: string;
}

export interface Waiting extends Partial<BeadReservation> {
  id: string;
  why: string;
  /** The bead it waits for, when it waits on an overlap. */
  waitsOn?: string;
  /** The shift whose worktree still holds its reservation, when it waits for that shift's earlier run of it. */
  waitsOnShift?: string;
}

export interface Stale {
  reservation: Reservation;
  why: StaleWhy;
}

export interface Eligibility {
  eligible: Eligible[];
  waiting: Waiting[];
  stale: Stale[];
}

/** The ordering edges among the candidates; parent-child and `relates` are not. */
function blockingEdges(candidates: readonly QueuedBead[]): BeadsDependency[] {
  const edges: BeadsDependency[] = [];
  const seen = new Set<string>();
  for (const bead of candidates)
    for (const dep of bead.dependencies ?? []) {
      if (dep.type !== "blocks" && dep.type !== "requires") continue;
      const key = `${dep.issue_id}\t${dep.depends_on_id}\t${dep.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: dep.issue_id, to: dep.depends_on_id, type: dep.type });
    }
  return edges;
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Candidates in bundle order. */
function inBundleOrder(candidates: readonly QueuedBead[]): QueuedBead[] {
  const byId = new Map(candidates.map((bead) => [bead.id, bead]));
  // planBundles reads an issue's id and status, and nothing else.
  const issues: BeadsIssue[] = candidates.map((bead) => ({
    id: bead.id,
    type: "task",
    title: bead.title ?? bead.id,
    status: bead.status === "closed" ? "closed" : "open",
    createdAt: "",
    updatedAt: "",
  }));
  const plan = planBundles("queue", issues, blockingEdges(candidates));
  const rank = (bead: QueuedBead) => bead.priority ?? 2;
  const layer = (layerIds: readonly string[]) =>
    layerIds
      .map((id) => byId.get(id))
      .filter((bead): bead is QueuedBead => bead !== undefined)
      .sort((a, b) => rank(a) - rank(b) || natural.compare(a.id, b.id));
  return [...plan.batches.flatMap(layer), ...layer(plan.unbatched)];
}

/** Globs as a message names them: each one at most 120 characters, and at most five. */
function named(globs: readonly string[]): string {
  const shown = globs.slice(0, 5).map((glob) => {
    // By character, so a cut never splits one.
    const characters = [...glob];
    return characters.length > 120
      ? `${characters.slice(0, 119).join("")}…`
      : glob;
  });
  return `${shown.join(", ")}${globs.length > 5 ? `, and ${globs.length - 5} more` : ""}`;
}

/** Why a queued bead waits for the earlier run whose reservation a shift's worktree still holds. */
function earlierRunWhy(
  beadId: string,
  worktree: string,
  shift: ShiftWorktree,
): string {
  // A pid the system gave to another program after the shift died reads as
  // live too: the operator who knows the shift is gone frees it by hand.
  if (shift.standing === "live")
    return `its earlier run in ${worktree} (shift ${shift.shiftId}) has not ended: it starts again once that run releases its reservation (if that shift is gone and its pid names another program now, bun run forge:reservations release ${beadId} ${worktree} frees it)`;
  if (shift.standing === "dead")
    return `its earlier run in ${worktree} (shift ${shift.shiftId}) still holds its reservation, and that shift's process has ended: bun run forge:shift recover ${shift.shiftId} frees it`;
  return `its reservation in ${worktree} is shift ${shift.shiftId}'s, whose record was not read here, so that run may not have ended: it starts again once the reservation is released (bun run forge:shift list shows the shift; forge:shift recover frees the reservations of one whose process ended, forge:reservations release one by hand)`;
}

export function eligibility(input: EligibilityInput): Eligibility {
  const stale: Stale[] = [];
  const candidateIds = new Set(input.candidates.map((bead) => bead.id));
  /** What each queued bead already holds, over all its worktrees. */
  const holds = new Map<string, string[]>();
  /**
   * A queued bead's reservation in the worktree of a shift that has not
   * stopped: its earlier run there may not have ended.
   */
  const earlierRuns = new Map<
    string,
    { worktree: string; shift: ShiftWorktree }
  >();
  /** Claims a bead is checked against: reservations of beads outside the queue, then what the walk has claimed. */
  const claims: Array<{ id: string; globs: readonly string[] }> = [];
  for (const reservation of input.active) {
    const why = input.staleIds.get(reservation.beadId);
    if (why !== undefined) stale.push({ reservation, why });
    else if (candidateIds.has(reservation.beadId)) {
      holds.set(reservation.beadId, [
        ...(holds.get(reservation.beadId) ?? []),
        ...reservation.globs,
      ]);
      const shift = input.shiftWorktrees?.get(reservation.worktree);
      if (
        shift !== undefined &&
        shift.standing !== "stopped" &&
        !earlierRuns.has(reservation.beadId)
      )
        earlierRuns.set(reservation.beadId, {
          worktree: reservation.worktree,
          shift,
        });
    } else claims.push({ id: reservation.beadId, globs: reservation.globs });
  }

  // The walk: beads in progress (running, reserved or not), then beads that
  // hold a reservation (they have, in effect, started), then the rest, each
  // group in bundle order. A bead is checked only against claims made before
  // it, and a bead in progress names no bead it waits on, so no two beads
  // ever wait on each other.
  const ordered = inBundleOrder(input.candidates);
  const inProgress = (bead: QueuedBead) => bead.status === "in_progress";
  const walk = [
    ...ordered.filter((bead) => inProgress(bead)),
    ...ordered.filter((bead) => !inProgress(bead) && holds.has(bead.id)),
    ...ordered.filter((bead) => !inProgress(bead) && !holds.has(bead.id)),
  ];

  const eligible: Eligible[] = [];
  const waiting: Waiting[] = [];
  for (const bead of walk) {
    const held = holds.get(bead.id);
    // What a bead holds claims, whatever else happens to it.
    if (held !== undefined) claims.push({ id: bead.id, globs: held });

    if (bead.issue_type === "epic") {
      waiting.push({
        id: bead.id,
        why: "an epic is worked through its children, not started itself",
      });
      continue;
    }
    if (input.host.busy) {
      waiting.push({
        id: bead.id,
        why: `the host is busy${input.host.reason ? `: ${input.host.reason}` : ""}`,
      });
      continue;
    }
    if (!input.readyIds.has(bead.id) && !inProgress(bead)) {
      waiting.push({
        id: bead.id,
        why: "it is blocked: it has an open blocker, so it is not ready",
      });
      continue;
    }

    const reserved = reservationFor(bead);
    // A bead in progress may be editing anything its map names now: that
    // claims before any other check, beside what it holds.
    if (inProgress(bead)) claims.push({ id: bead.id, globs: reserved.globs });
    // Its earlier run may still be running in a shift's worktree (paused and
    // resumed before that shift noticed): a start now would run it twice.
    // What it holds has claimed already, so nothing jumps it meanwhile.
    const earlier = earlierRuns.get(bead.id);
    if (earlier !== undefined) {
      waiting.push({
        id: bead.id,
        why: earlierRunWhy(bead.id, earlier.worktree, earlier.shift),
        waitsOnShift: earlier.shift.shiftId,
        ...reserved,
      });
      continue;
    }
    if (
      held !== undefined &&
      !reserved.globs.every((glob) => held.includes(glob))
    ) {
      waiting.push({
        id: bead.id,
        why: `its file map changed since it was reserved (reserved ${named(held)}; the map says ${named(reserved.globs)}): release and reserve again`,
        ...reserved,
      });
      continue;
    }
    if (held !== undefined) {
      // Two beads that both hold overlapping reservations (written past the
      // lock, or by hand) are both held back, naming neither: release one.
      const clash = [...holds].find(
        ([other, globs]) =>
          other !== bead.id && overlapOf(held, globs) !== null,
      );
      if (clash !== undefined) {
        waiting.push({
          id: bead.id,
          why: `its reservation overlaps the one ${clash[0]} holds: release one of them (forge:reservations release)`,
          ...reserved,
        });
        continue;
      }
    }
    const before = claims.find(
      (claim) =>
        claim.id !== bead.id && overlapOf(reserved.globs, claim.globs) !== null,
    );
    // Claimed as it is passed, whatever it gets: nothing after it jumps it.
    if (held === undefined && !inProgress(bead))
      claims.push({ id: bead.id, globs: reserved.globs });
    if (inProgress(bead)) {
      waiting.push({ id: bead.id, why: "it is in progress", ...reserved });
      continue;
    }
    if (before !== undefined) {
      const [mine, theirs] = overlapOf(reserved.globs, before.globs) ?? [
        "",
        "",
      ];
      waiting.push({
        id: bead.id,
        why: `its ${named([mine])} overlaps ${named([theirs])}, claimed by ${before.id}`,
        waitsOn: before.id,
        ...reserved,
      });
      continue;
    }
    eligible.push({ id: bead.id, ...reserved });
  }
  return { eligible, waiting, stale };
}

// ── From bd and the ledger ──────────────────────────────────────────────────

export interface EligibilityDeps {
  /** The checkout whose tracker and workspace are read. */
  root: string;
  /** Runs `bd` in the checkout that holds the tracker (the main checkout). */
  runBd: BdRunner;
  ledgerPath: string;
  host: { busy: boolean; reason?: string };
  /**
   * The shift records (`<home>/shifts`), read to say how a shift whose
   * worktree holds a queued bead's reservation stands. Without it none is
   * read: such a bead still waits, with the words for a shift whose record
   * was not found.
   */
  shiftsDir?: string | undefined;
}

export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

async function listed(
  runBd: BdRunner,
  args: string[],
): Promise<Read<QueuedBead[]>> {
  let result: BdResult;
  try {
    result = await runBd(args);
  } catch {
    return { ok: false, error: "bd list could not be run" };
  }
  if (result.status !== 0)
    return { ok: false, error: `bd list failed: ${refusal(result)}` };
  const rows = parsed(result.stdout);
  if (!Array.isArray(rows))
    return { ok: false, error: "bd list did not answer a JSON list" };
  return {
    ok: true,
    value: rows.filter(
      (row): row is QueuedBead =>
        typeof (row as QueuedBead | null)?.id === "string",
    ),
  };
}

/** Which of `ids` are closed or no longer exist. A row bd returns for another id (a partial match) counts for nothing. */
export async function staleOf(
  runBd: BdRunner,
  ids: readonly string[],
): Promise<Read<Map<string, StaleWhy>>> {
  const stale = new Map<string, StaleWhy>();
  if (ids.length === 0) return { ok: true, value: stale };
  let result: BdResult;
  try {
    result = await runBd(["show", "--readonly", "--json", "--", ...ids]);
  } catch {
    return { ok: false, error: "bd show could not be run" };
  }
  const answer = parsed(result.stdout);
  if (result.status !== 0) {
    const error = (answer as { error?: unknown } | null)?.error;
    if (typeof error === "string" && /no issues? found/i.test(error)) {
      for (const id of ids) stale.set(id, "gone");
      return { ok: true, value: stale };
    }
    return { ok: false, error: `bd show failed: ${refusal(result)}` };
  }
  const rows = Array.isArray(answer) ? answer : [];
  const status = new Map<string, unknown>();
  for (const row of rows) {
    const r = row as { id?: unknown; status?: unknown } | null;
    if (typeof r?.id === "string") status.set(r.id, r.status);
  }
  for (const id of ids) {
    if (!status.has(id)) stale.set(id, "gone");
    else if (status.get(id) === "closed") stale.set(id, "closed");
  }
  return { ok: true, value: stale };
}

/**
 * The shift each queued bead's reservation worktree was made for, by the
 * worktree as the reservation stores it, and how that shift stands: one
 * record read (and one process asked) per shift, only for the reservations
 * of `queued` beads in `<main>/trees/<shift-id>-<n>`.
 */
function shiftWorktreesOf(
  active: readonly Reservation[],
  queued: ReadonlySet<string>,
  workspace: string,
  shiftsDir: string | undefined,
): Map<string, ShiftWorktree> {
  const found = new Map<string, ShiftWorktree>();
  const standings = new Map<string, ShiftStanding>();
  const trees = comparablePath(join(workspace, "trees"));
  for (const reservation of active) {
    if (!queued.has(reservation.beadId)) continue;
    const shiftId = shiftOfWorktree(
      trees,
      comparablePath(reservation.worktree),
    );
    if (shiftId === null) continue;
    let standing = standings.get(shiftId);
    if (standing === undefined) {
      standing =
        shiftsDir === undefined
          ? "unknown"
          : shiftStanding(shiftsDir, shiftId, workspace);
      standings.set(shiftId, standing);
    }
    found.set(reservation.worktree, { shiftId, standing });
  }
  return found;
}

/**
 * Eligibility now, from the tracker, the ledger and the shift records: the
 * exact queued set, which of it is ready, the reservations of the checkout's
 * workspace, which reserved beads outside the queue are closed or gone, and
 * how each shift stands whose worktree holds a queued bead's reservation. A
 * `bd` failure is an error, not an empty queue. Writes nothing.
 *
 * A listed bead that also carries a `queue:` label that is not a state is
 * dropped (`pickableRow`): the listing cannot exclude it and `start` refuses
 * it. A reservation it holds then counts as one outside the queue.
 */
export async function readEligibility(
  deps: EligibilityDeps,
): Promise<Read<Eligibility>> {
  const listedQueued = await listed(deps.runBd, [...QUEUED_EXACT_ARGS]);
  if (!listedQueued.ok) return listedQueued;
  const candidates = listedQueued.value.filter(pickableRow);
  const ready = await listed(deps.runBd, [...QUEUED_EXACT_ARGS, "--ready"]);
  if (!ready.ok) return ready;
  const { workspace } = resolveCheckout(deps.root);
  const active = activeReservations({ workspace }, { path: deps.ledgerPath });
  const queuedIds = new Set(candidates.map((bead) => bead.id));
  const outside = [
    ...new Set(
      active
        .map((reservation) => reservation.beadId)
        .filter((id) => !queuedIds.has(id)),
    ),
  ];
  const stale = await staleOf(deps.runBd, outside);
  if (!stale.ok) return stale;
  return {
    ok: true,
    value: eligibility({
      candidates,
      readyIds: new Set(ready.value.map((bead) => bead.id)),
      active,
      staleIds: stale.value,
      host: deps.host,
      shiftWorktrees: shiftWorktreesOf(
        active,
        queuedIds,
        workspace,
        deps.shiftsDir,
      ),
    }),
  };
}

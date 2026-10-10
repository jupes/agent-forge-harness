/**
 * Writing to the tracker from the page: create, claim, comment, close.
 *
 * Each write is one operator action posted to the control plane, which makes
 * one `bd` call and answers what `bd` said. Three things are decided here, on
 * the page's side of that:
 *
 * - whether there is a control plane at all (a static copy of the dashboard
 *   has none, and can only build the command to paste);
 * - what an answer means. A refusal is a failure. A 504, an answer that did
 *   not come from the control plane, and a request that never completed are
 *   not: the change may have been made, and the page says so instead of
 *   inviting a second create or a second comment;
 * - what this page's actions changed. The issue lists are a snapshot that a
 *   write does not rebuild, so the answers are kept here, by bead, and shown
 *   over the snapshot until the snapshot says the same or something later.
 */

import { useEffect, useState } from "preact/hooks";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import { parseBeadsIssueId } from "../../../scripts/run-correlation";
import type { BeadOptions, BeadWriteResult } from "../../../types/hearth";
import { type OperatorPost, operatorPost } from "../operator";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type WriteOutcome =
  | { ok: true; data: BeadWriteResult }
  | {
      ok: false;
      error: string;
      /** True when the change may have been made and the page cannot tell. */
      unknown: boolean;
    };

export type Availability =
  | { available: true; options: BeadOptions }
  | { available: false; reason: string };

/** What a create sends. Empty optional fields are left out. */
export interface CreateFields {
  title: string;
  type: string;
  priority: string;
  parent?: string;
  description?: string;
  acceptance?: string;
}

export const NO_CONTROL_PLANE =
  "Needs the local control plane: start the dashboard with `bun run dashboard`. A static copy of this page can only build the command.";

const OPTIONS_ROUTE = `${API_PREFIX}/beads/options`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The control plane's `{ ok, data, error }`, or null for anything else. */
function envelopeOf(
  value: unknown,
): { ok: boolean; data: unknown; error: string | null } | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  const error = value["error"];
  if (error !== null && typeof error !== "string") return null;
  return { ok: value["ok"], data: value["data"], error };
}

function isOptions(value: unknown): value is BeadOptions {
  return (
    isRecord(value) &&
    Array.isArray(value["types"]) &&
    Array.isArray(value["priorities"]) &&
    typeof value["defaultPriority"] === "string" &&
    isRecord(value["limits"])
  );
}

function isResult(value: unknown): value is BeadWriteResult {
  return (
    isRecord(value) &&
    parseBeadsIssueId(value["id"]) === value["id"] &&
    typeof value["action"] === "string"
  );
}

/** How an outcome nobody can vouch for is put: never as a failure. */
function unknownOutcome(what: string, check: string): WriteOutcome {
  return {
    ok: false,
    unknown: true,
    error: `${what} The change may have been made: check with \`${check}\` before trying again.`,
  };
}

export interface BeadWrites {
  /** Whether a control plane is there, and what a create may say. */
  options(): Promise<Availability>;
  create(fields: CreateFields): Promise<WriteOutcome>;
  claim(id: string): Promise<WriteOutcome>;
  comment(id: string, text: string): Promise<WriteOutcome>;
  close(id: string, reason: string): Promise<WriteOutcome>;
}

/** The writes, with their own memory of the options; `post` and `fetchImpl` are replaced in tests. */
export function createBeadWrites(
  post: OperatorPost = operatorPost,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): BeadWrites {
  let known: Promise<Availability> | null = null;

  async function readOptions(): Promise<Availability> {
    try {
      const response = await fetchImpl(OPTIONS_ROUTE);
      const envelope = envelopeOf(await response.json());
      if (response.ok && envelope?.ok && isOptions(envelope.data))
        return { available: true, options: envelope.data };
    } catch {
      // No answer, or one that is not JSON: there is no control plane to ask.
    }
    return { available: false, reason: NO_CONTROL_PLANE };
  }

  function options(): Promise<Availability> {
    if (known === null) {
      const reading = readOptions();
      known = reading;
      // "Not there" is not remembered: the dashboard starts a control plane
      // again without the page knowing, and the next look should find it.
      void reading.then((availability) => {
        if (!availability.available && known === reading) known = null;
      });
    }
    return known;
  }

  /** One POST, and what its answer means. `check` is how the operator can see for themselves. */
  async function send(
    path: string,
    body: unknown,
    check: string,
  ): Promise<WriteOutcome> {
    const availability = await options();
    if (!availability.available)
      return { ok: false, unknown: false, error: availability.reason };
    let response: Response;
    let parsed: unknown;
    try {
      response = await post(`${API_PREFIX}${path}`, body);
      parsed = await response.json().catch(() => null);
    } catch {
      return unknownOutcome("The request did not complete.", check);
    }
    const envelope = envelopeOf(parsed);
    if (envelope === null)
      return unknownOutcome(
        `The answer (HTTP ${response.status}) did not come from the control plane.`,
        check,
      );
    if (response.ok && envelope.ok && isResult(envelope.data))
      return { ok: true, data: envelope.data };
    if (response.ok)
      return unknownOutcome(
        "The control plane answered without saying what was written.",
        check,
      );
    return {
      ok: false,
      // 504 is the one status the control plane uses for "outcome not known";
      // its message already says how to check.
      unknown: response.status === 504,
      error: envelope.error ?? `HTTP ${response.status}`,
    };
  }

  /** A write to a bead that exists: the id is checked here, before it is put in a path. */
  function toBead(
    id: string,
    action: string,
    body: unknown,
  ): Promise<WriteOutcome> {
    if (parseBeadsIssueId(id) !== id)
      return Promise.resolve({
        ok: false,
        unknown: false,
        error: "That is not a Beads issue id.",
      });
    return send(
      `/beads/${encodeURIComponent(id)}/${action}`,
      body,
      `bd show ${id}`,
    );
  }

  return {
    options,
    create(fields) {
      const kept = (text: string | undefined): string | undefined =>
        text !== undefined && text.trim().length > 0 ? text : undefined;
      const parent = kept(fields.parent)?.trim();
      const description = kept(fields.description);
      const acceptance = kept(fields.acceptance);
      return send(
        "/beads",
        {
          title: fields.title,
          type: fields.type,
          priority: fields.priority,
          ...(parent !== undefined ? { parent } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(acceptance !== undefined ? { acceptance } : {}),
        },
        // A create that was not answered left no id to look up.
        "bd list",
      );
    },
    claim: (id) => toBead(id, "claim", {}),
    comment: (id, text) => toBead(id, "comment", { text }),
    close: (id, reason) => toBead(id, "close", { reason }),
  };
}

/** The page's writes: one memory of the options for every island. */
export const beadWrites: BeadWrites = createBeadWrites();

/** One action on a bead: offered, or not and why. */
export type Offer = { enabled: true } | { enabled: false; reason: string };

type Plane = { available: true } | { available: false; reason: string };

/** Which of claim, comment and close a bead in `status` is offered. */
export function actionState(input: Plane & { status: string }): {
  claim: Offer;
  comment: Offer;
  close: Offer;
} {
  if (!input.available) {
    const none: Offer = { enabled: false, reason: input.reason };
    return { claim: none, comment: none, close: none };
  }
  const closed = input.status === "closed";
  return {
    claim: closed
      ? { enabled: false, reason: "A closed bead cannot be claimed." }
      : input.status === "in_progress"
        ? { enabled: false, reason: "This bead is already in progress." }
        : { enabled: true },
    comment: { enabled: true },
    close: closed
      ? { enabled: false, reason: "This bead is already closed." }
      : { enabled: true },
  };
}

/**
 * Whether Create may be pressed. Create sends the title, type, priority,
 * parent, description and acceptance criteria to this checkout's tracker; it
 * does not send Labels or another Repo, so while either is set it is not
 * offered: nothing the form shows is dropped without a word.
 */
export function createState(
  input: Plane & { labels: string; repo: string },
): Offer {
  if (!input.available) return { enabled: false, reason: input.reason };
  const labelled = input.labels.split(",").some((label) => label.trim() !== "");
  if (labelled)
    return {
      enabled: false,
      reason:
        "Create does not send Labels. Clear the field to create the bead here, or copy the command to keep them.",
    };
  const repo = input.repo.trim();
  if (repo !== "" && repo !== ".")
    return {
      enabled: false,
      reason:
        "Create files the bead in this checkout's tracker. Set Repo back to `.` to create it here, or copy the command for another repo.",
    };
  return { enabled: true };
}

// ── What this page's actions changed ────────────────────────────────────────

/** A comment this page added, with the text it sent. */
export interface AppliedComment {
  id: string;
  author: string;
  createdAt: string;
  text: string;
}

/** What the page sent when it created a bead: enough to show it again. */
export interface CreatedFields {
  title: string;
  type: string;
  priority: string;
  parent?: string;
}

/** What this page's actions changed about one bead, as `bd` answered it. */
export interface Applied {
  id: string;
  status?: string;
  assignee?: string;
  labels?: string[];
  /** When `bd` said the bead last changed, for the answer the status came from. */
  updatedAt?: string;
  comments: AppliedComment[];
  /** Set when the bead was created from this page. */
  created?: CreatedFields;
  /** Order of last change: larger is later. */
  at: number;
}

/** What the snapshot says about a bead: what the detail panel is given. */
export interface SnapshotIssue {
  status: string;
  updatedAt?: string;
  comments: ReadonlyArray<{ body: string }>;
}

export interface AppliedStore {
  /** Keep what a confirmed write answered. `sent` is what only the page knows: the text, the fields of a create. */
  record(
    result: BeadWriteResult,
    sent?: { text?: string; created?: CreatedFields },
  ): void;
  get(id: string): Applied | undefined;
  /** The beads created from this page, newest first. */
  created(): Applied[];
  /**
   * Drop what the snapshot now says itself, or has since contradicted: a
   * status the issue agrees with, or one the issue has changed since (a change
   * made elsewhere is not masked); a comment the issue now has; the "created
   * here" of a bead the snapshot holds. A snapshot that is only regenerated
   * drops nothing: its issue is the same.
   */
  reconcile(id: string, issue: SnapshotIssue): void;
  subscribe(listener: () => void): () => void;
}

type Stored = Pick<Storage, "getItem" | "setItem">;

const STORE_KEY = "agent-forge.bead-writes.v1";
/** How many beads are remembered; the one changed longest ago goes first. */
const KEPT = 50;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** One entry as it was stored, or null: what storage holds is not trusted. */
function entryOf(value: unknown): Applied | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "string" || parseBeadsIssueId(id) !== id) return null;
  const comments = Array.isArray(value["comments"]) ? value["comments"] : [];
  const created = value["created"];
  const status = text(value["status"]);
  const assignee = text(value["assignee"]);
  const updatedAt = text(value["updatedAt"]);
  const labels = Array.isArray(value["labels"])
    ? value["labels"].filter((label) => typeof label === "string")
    : undefined;
  return {
    id,
    ...(status !== undefined ? { status } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    comments: comments.flatMap((comment): AppliedComment[] => {
      if (!isRecord(comment)) return [];
      const fields = {
        id: text(comment["id"]),
        author: text(comment["author"]),
        createdAt: text(comment["createdAt"]),
        text: text(comment["text"]),
      };
      return fields.id !== undefined &&
        fields.author !== undefined &&
        fields.createdAt !== undefined &&
        fields.text !== undefined
        ? [fields as AppliedComment]
        : [];
    }),
    ...(isRecord(created) &&
    typeof created["title"] === "string" &&
    typeof created["type"] === "string" &&
    typeof created["priority"] === "string"
      ? {
          created: {
            title: created["title"],
            type: created["type"],
            priority: created["priority"],
            ...(typeof created["parent"] === "string"
              ? { parent: created["parent"] }
              : {}),
          },
        }
      : {}),
    at: typeof value["at"] === "number" ? value["at"] : 0,
  };
}

/** Line endings as the control plane hands them to `bd`. */
const folded = (value: string): string => value.replace(/\r\n?/g, "\n");

/**
 * The store. It is held in memory and mirrored to `storage` (the tab's
 * `sessionStorage`), so it outlives the panel that showed an answer and a
 * reload of the page: the dev server reloads the page when the tracker
 * changes, and a lost confirmation invites a second create or comment.
 * A storage that is absent or throws leaves a store that lasts as long as the
 * page does.
 */
export function createAppliedStore(storage: Stored | null): AppliedStore {
  const beads = new Map<string, Applied>();
  const listeners = new Set<() => void>();
  let clock = 0;

  try {
    const stored: unknown = JSON.parse(storage?.getItem(STORE_KEY) ?? "null");
    const entries =
      isRecord(stored) && Array.isArray(stored["beads"]) ? stored["beads"] : [];
    for (const value of entries) {
      const entry = entryOf(value);
      if (entry === null) continue;
      beads.set(entry.id, entry);
      clock = Math.max(clock, entry.at);
    }
  } catch {
    // Unreadable storage is an empty store.
  }

  function changed(): void {
    try {
      storage?.setItem(
        STORE_KEY,
        JSON.stringify({ beads: [...beads.values()] }),
      );
    } catch {
      // A full or forbidden storage costs only the survival of a reload.
    }
    for (const listener of listeners) listener();
  }

  return {
    record(result, sent = {}) {
      const before = beads.get(result.id);
      const comment =
        result.comment !== undefined && sent.text !== undefined
          ? [{ ...result.comment, text: folded(sent.text) }]
          : [];
      const entry: Applied = {
        ...before,
        id: result.id,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.assignee !== undefined ? { assignee: result.assignee } : {}),
        ...(result.labels !== undefined ? { labels: result.labels } : {}),
        ...(result.updatedAt !== undefined
          ? { updatedAt: result.updatedAt }
          : {}),
        comments: [...(before?.comments ?? []), ...comment],
        ...(sent.created !== undefined ? { created: sent.created } : {}),
        at: ++clock,
      };
      beads.set(entry.id, entry);
      if (beads.size > KEPT) {
        const oldest = [...beads.values()].sort((a, b) => a.at - b.at)[0];
        if (oldest !== undefined) beads.delete(oldest.id);
      }
      changed();
    },
    get: (id) => beads.get(id),
    created: () =>
      [...beads.values()]
        .filter((bead) => bead.created !== undefined)
        .sort((a, b) => b.at - a.at),
    reconcile(id, issue) {
      const entry = beads.get(id);
      if (entry === undefined) return;
      const later =
        entry.updatedAt !== undefined &&
        issue.updatedAt !== undefined &&
        Date.parse(issue.updatedAt) > Date.parse(entry.updatedAt);
      const settled =
        entry.status !== undefined && (issue.status === entry.status || later);
      const comments = entry.comments.filter(
        (comment) =>
          !issue.comments.some((found) => folded(found.body) === comment.text),
      );
      if (
        !settled &&
        comments.length === entry.comments.length &&
        entry.created === undefined
      )
        return;
      // The bead is in the snapshot: it is no longer only "created here".
      const { created: _created, ...rest } = entry;
      const { status, assignee, labels, updatedAt, ...unsettled } = rest;
      const next: Applied = settled
        ? { ...unsettled, comments }
        : {
            ...unsettled,
            ...(status !== undefined ? { status } : {}),
            ...(assignee !== undefined ? { assignee } : {}),
            ...(labels !== undefined ? { labels } : {}),
            ...(updatedAt !== undefined ? { updatedAt } : {}),
            comments,
          };
      if (next.status === undefined && next.comments.length === 0)
        beads.delete(id);
      else beads.set(id, next);
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The tab's `sessionStorage`, when the page has one it may use. */
function sessionStore(): Stored | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** What this page's actions changed: one store for every island. */
export const applied: AppliedStore = createAppliedStore(sessionStore());

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Whether a control plane is there; null until the page has asked. */
export function useBeadWrites(): Availability | null {
  const [availability, setAvailability] = useState<Availability | null>(null);
  useEffect(() => {
    let mounted = true;
    void beadWrites.options().then((answer) => {
      if (mounted) setAvailability(answer);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return availability;
}

/** Re-render whenever the store changes. */
function useStore(): void {
  const [, bump] = useState(0);
  useEffect(() => applied.subscribe(() => bump((count) => count + 1)), []);
}

/** What this page's actions changed about `id`, kept current. */
export function useApplied(id: string): Applied | undefined {
  useStore();
  return applied.get(id);
}

/** The beads created from this page, newest first, kept current. */
export function useCreated(): Applied[] {
  useStore();
  return applied.created();
}

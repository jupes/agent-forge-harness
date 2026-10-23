import type { ActionOutcome } from "../../../docs/js/action-outcome";
import {
  MAX_SESSION_EXPORT_BYTES,
  sessionLibraryListSchema,
  sessionLibraryReadSchema,
  sessionTranscriptExportSchema,
} from "../../../scripts/sessions/library-protocol";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type {
  SessionArchiveRequest,
  SessionLibraryEntry,
  SessionLibraryRead,
} from "../../../types/session-library";
import type {
  SessionArchiveJournal,
  SessionArchiveMarker,
} from "./session-archive-journal";

export interface SessionLibraryProjectView {
  entries: SessionLibraryEntry[];
  loaded: boolean;
  loading: boolean;
  error: string;
  showArchived: boolean;
}
export interface SessionLibraryView {
  record: OwnedCodingSessionRecord;
  entry: SessionLibraryEntry | null;
  pending: SessionArchiveMarker | null;
  held: boolean;
  checking: boolean;
  posting: boolean;
  exporting: boolean;
  notice: string;
  error: string;
  readGeneration: number;
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The saved session change could not be read.";
const sameOriginal = (
  left: SessionArchiveRequest,
  right: SessionArchiveRequest,
) =>
  left.requestId === right.requestId &&
  left.expectedRevision === right.expectedRevision &&
  left.archived === right.archived;
const sameEntry = (
  record: OwnedCodingSessionRecord,
  entry: SessionLibraryEntry,
) =>
  record.projectId === entry.projectId &&
  record.id === entry.sessionId &&
  record.requestId === entry.startRequestId &&
  record.requestHash === entry.startRequestHash;

/** App-root metadata/recovery coordinator. It never starts, resumes or stops a provider. */
export function createSessionLibraryClient(deps: {
  canWrite(): boolean;
  requestId(): string;
  journal: SessionArchiveJournal;
  list(projectId: string): Promise<unknown>;
  read(record: OwnedCodingSessionRecord, requestId?: string): Promise<unknown>;
  post(
    record: OwnedCodingSessionRecord,
    original: SessionArchiveRequest,
  ): Promise<ActionOutcome>;
  exportTranscript(record: OwnedCodingSessionRecord): Promise<unknown>;
  download(filename: string, text: string): void | Promise<void>;
}) {
  const projects = new Map<string, SessionLibraryProjectView>();
  const sessions = new Map<string, SessionLibraryView>();
  const listeners = new Set<() => void>();
  let projectId: string | null = null,
    selected: SessionLibraryView | null = null,
    generation = 0,
    disposed = false;
  const tell = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const project = (id: string) => {
    let found = projects.get(id);
    if (!found) {
      found = {
        entries: [],
        loaded: false,
        loading: false,
        error: "",
        showArchived: false,
      };
      projects.set(id, found);
    }
    return found;
  };
  const current = (view: SessionLibraryView, ticket: number) =>
    !disposed && selected === view && generation === ticket;
  const install = (view: SessionLibraryView, entry: SessionLibraryEntry) => {
    if (!sameEntry(view.record, entry))
      throw Error("The library reply belongs to a different original session.");
    if (view.entry && entry.revision < view.entry.revision) return;
    if (
      view.entry &&
      entry.revision === view.entry.revision &&
      entry.archived !== view.entry.archived
    )
      throw Error(
        "The archive reply conflicts with its verified saved revision.",
      );
    view.entry = structuredClone(entry);
    const list = project(entry.projectId);
    list.entries = [
      ...list.entries.filter((item) => item.sessionId !== entry.sessionId),
      structuredClone(entry),
    ];
  };
  const take = (view: SessionLibraryView, raw: unknown) => {
    const parsed = sessionLibraryReadSchema.safeParse(raw);
    if (!parsed.success || !sameEntry(view.record, parsed.data.entry))
      throw Error(
        "The library reply could not be verified for this original session.",
      );
    return parsed.data;
  };
  const confirm = async (
    view: SessionLibraryView,
    marker: SessionArchiveMarker,
    value: SessionLibraryRead,
    ticket: number,
  ) => {
    const receipt = value.receipt;
    if (!receipt || !sameOriginal(marker.original, receipt.original))
      throw Error(
        "The original archive change is not confirmed. Its UUID and preference have been kept.",
      );
    install(view, value.entry);
    await deps.journal.settle(marker, receipt);
    if (
      !current(view, ticket) ||
      view.pending?.original.requestId !== marker.original.requestId
    )
      return;
    view.pending = null;
    view.held = false;
    view.error = "";
    view.notice =
      receipt.outcome === "refused"
        ? (receipt.reason ?? "The archive change was refused.")
        : value.entry.archived
          ? "Session archived. Its history and running work are preserved."
          : "Session restored to the app sessions list.";
  };
  const refresh = async () => {
    if (!projectId || disposed) return;
    const id = projectId,
      ticket = generation,
      view = project(id);
    view.loading = true;
    tell();
    try {
      const raw = await deps.list(id);
      if (disposed || generation !== ticket || projectId !== id) return;
      const parsed = sessionLibraryListSchema.safeParse(raw);
      if (!parsed.success || parsed.data.projectId !== id)
        throw Error(
          "The archive preference list could not be verified for this project.",
        );
      view.entries = parsed.data.entries.map((entry) => {
        const known = view.entries.find(
          (item) => item.sessionId === entry.sessionId,
        );
        if (
          known &&
          known.startRequestHash === entry.startRequestHash &&
          known.revision === entry.revision &&
          known.archived !== entry.archived
        )
          throw Error(
            "The archive list conflicts with its verified saved revision.",
          );
        if (
          known &&
          known.startRequestHash === entry.startRequestHash &&
          known.revision > entry.revision
        )
          return known;
        return entry;
      });
      view.loaded = true;
      view.error = "";
    } catch (error) {
      if (disposed || generation !== ticket || projectId !== id) return;
      view.error = `${message(error)} All registered sessions remain visible until archive preferences can be read.`;
    } finally {
      if (!disposed && generation === ticket && projectId === id) {
        view.loading = false;
        tell();
      }
    }
  };
  const check = async () => {
    const view = selected;
    if (!view || disposed) return;
    const ticket = generation,
      readTicket = ++view.readGeneration;
    const startingRevision = view.entry?.revision ?? -1;
    let requestedId: string | null = null;
    view.checking = true;
    tell();
    try {
      const held = deps.journal.pending(view.record);
      if (held) view.pending = held;
      view.held = false;
      const marker = view.pending;
      requestedId = marker?.original.requestId ?? null;
      const raw = await deps.read(view.record, marker?.original.requestId);
      if (!current(view, ticket) || view.readGeneration !== readTicket) return;
      const value = take(view, raw);
      if (marker) {
        if (view.pending?.original.requestId !== marker.original.requestId)
          return;
        await confirm(view, marker, value, ticket);
      } else {
        if (value.receipt)
          throw Error(
            "An unrequested archive receipt was returned. No change was made.",
          );
        install(view, value.entry);
        view.error = "";
      }
    } catch (error) {
      if (!current(view, ticket) || view.readGeneration !== readTicket) return;
      if (
        (requestedId && view.pending?.original.requestId !== requestedId) ||
        (view.entry?.revision ?? -1) > startingRevision
      )
        return;
      view.error = message(error);
      if (view.pending)
        view.notice =
          "Archive change not confirmed. Check or explicitly retry the same original change; its UUID and preference are kept.";
      else view.held = true;
    } finally {
      if (current(view, ticket) && view.readGeneration === readTicket) {
        view.checking = false;
        tell();
      }
    }
  };
  const postOriginal = async (
    view: SessionLibraryView,
    marker: SessionArchiveMarker,
    ticket: number,
  ) => {
    try {
      deps.journal.verify(marker);
      if (
        !current(view, ticket) ||
        !deps.canWrite() ||
        view.pending?.original.requestId !== marker.original.requestId
      )
        return;
      const result = await deps.post(
        view.record,
        structuredClone(marker.original),
      );
      if (
        !current(view, ticket) ||
        view.pending?.original.requestId !== marker.original.requestId
      )
        return;
      if (result.state !== "done")
        throw Error(
          `${result.message} The original archive change is not confirmed.`,
        );
      await confirm(view, marker, take(view, result.data), ticket);
    } catch (error) {
      if (
        !current(view, ticket) ||
        view.pending?.original.requestId !== marker.original.requestId
      )
        return;
      view.error = message(error);
      view.notice =
        "Archive change not confirmed. Check or explicitly retry this exact original change.";
    } finally {
      view.posting = false;
      tell();
    }
  };
  const client = {
    project,
    current: () => selected,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(id: string | null, record: OwnedCodingSessionRecord | null) {
      if (disposed) return;
      if (
        projectId === id &&
        selected?.record.id === record?.id &&
        selected?.record.requestHash === record?.requestHash &&
        selected?.record.workspace === record?.workspace
      )
        return;
      generation++;
      projectId = id;
      selected = null;
      if (record && id === record.projectId) {
        const key = `${id}:${record.id}`;
        const cached = sessions.get(key);
        const found =
          cached &&
          cached.record.requestHash === record.requestHash &&
          cached.record.requestId === record.requestId &&
          cached.record.workspace === record.workspace
            ? cached
            : undefined;
        selected = found ?? {
          record: structuredClone(record),
          entry: null,
          pending: null,
          held: false,
          checking: false,
          posting: false,
          exporting: false,
          notice: "",
          error: "",
          readGeneration: 0,
        };
        selected.record = structuredClone(record);
        sessions.set(key, selected);
      }
      tell();
      void refresh();
      void check();
    },
    refresh,
    check,
    showArchived(value: boolean) {
      if (projectId) {
        project(projectId).showArchived = value;
        tell();
      }
    },
    refreshIdentities() {
      void check();
      void refresh();
    },
    canChange() {
      return (
        !!selected?.entry &&
        sameEntry(selected.record, selected.entry) &&
        deps.canWrite() &&
        !selected.pending &&
        !selected.held &&
        !selected.posting &&
        !selected.checking
      );
    },
    async change(archived: boolean) {
      const view = selected;
      if (!view || !view.entry || !client.canChange()) return;
      const ticket = generation;
      view.posting = true;
      tell();
      try {
        const reserved = await deps.journal.reserve(
          view.record,
          { expectedRevision: view.entry.revision, archived },
          deps.requestId,
        );
        view.pending = reserved.marker;
        if (!current(view, ticket) || !deps.canWrite()) {
          view.notice =
            "The original archive change is held before delivery. Check or retry it explicitly.";
          view.posting = false;
          tell();
          return;
        }
        if (!reserved.created) {
          view.notice =
            "Another window already holds this original archive change. Check it before retrying.";
          view.posting = false;
          tell();
          return;
        }
        await postOriginal(view, reserved.marker, ticket);
      } catch (error) {
        view.held = true;
        view.error = message(error);
        view.notice =
          "The archive identity could not be verified. No change was sent.";
        view.posting = false;
        tell();
      }
    },
    async retry() {
      const view = selected;
      if (!view?.pending || view.posting || view.checking || !deps.canWrite())
        return;
      view.posting = true;
      tell();
      await postOriginal(view, view.pending, generation);
    },
    async exportTranscript() {
      const view = selected;
      if (!view || view.exporting || disposed) return;
      const ticket = generation;
      view.exporting = true;
      tell();
      try {
        const raw = await deps.exportTranscript(view.record);
        if (!current(view, ticket)) return;
        const parsed = sessionTranscriptExportSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.session.projectId !== view.record.projectId ||
          parsed.data.session.id !== view.record.id ||
          parsed.data.session.requestId !== view.record.requestId ||
          parsed.data.session.requestHash !== view.record.requestHash
        )
          throw Error(
            "The complete export could not be verified for this original session. No file was downloaded.",
          );
        const text = `${JSON.stringify(parsed.data)}\n`;
        if (new TextEncoder().encode(text).length > MAX_SESSION_EXPORT_BYTES)
          throw Error(
            "The complete transcript exceeds the 8 MiB export limit. No partial file was downloaded.",
          );
        await deps.download(
          `${view.record.id}-r${parsed.data.conversation.revision}.json`,
          text,
        );
        if (current(view, ticket))
          view.notice = `Transcript download requested for saved revision ${parsed.data.conversation.revision}. Running work may add later activity.`;
      } catch (error) {
        if (current(view, ticket)) view.error = message(error);
      } finally {
        view.exporting = false;
        tell();
      }
    },
    dispose() {
      disposed = true;
      generation++;
      selected = null;
      listeners.clear();
    },
  };
  return client;
}
export type SessionLibraryClient = ReturnType<
  typeof createSessionLibraryClient
>;

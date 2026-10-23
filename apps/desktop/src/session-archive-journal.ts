import { z } from "zod";
import {
  sessionArchiveReceiptSchema,
  sessionArchiveRequestSchema,
} from "../../../scripts/sessions/library-protocol";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "../../../scripts/sessions/protocol";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type {
  SessionArchiveReceipt,
  SessionArchiveRequest,
} from "../../../types/session-library";

export const SESSION_ARCHIVE_JOURNAL =
  "agent-forge.owned-session-archive-identities.v1";
export const MAX_ARCHIVE_JOURNAL_BYTES = 2 * 1024 * 1024;
const source = z
  .object({
    projectId: sessionProjectIdSchema,
    sessionId: ownedSessionIdSchema,
    startRequestId: sessionRequestIdSchema,
    startRequestHash: sessionRequestHashSchema,
    workspace: ownedSessionMetadataSchema.shape.workspace,
  })
  .strict();
const markerSchema = z
  .object({
    source,
    original: sessionArchiveRequestSchema,
    settled: z.boolean(),
  })
  .strict();
const schema = z
  .object({ version: z.literal(1), records: z.array(markerSchema).max(1000) })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.source.sessionId)).size ===
        value.records.length &&
      new Set(value.records.map((record) => record.original.requestId)).size ===
        value.records.length,
  );
export type SessionArchiveMarker = z.infer<typeof markerSchema>;
const identity = (record: OwnedCodingSessionRecord) =>
  source.parse({
    projectId: record.projectId,
    sessionId: record.id,
    startRequestId: record.requestId,
    startRequestHash: record.requestHash,
    workspace: record.workspace,
  });
const equal = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Only archive metadata is stored. An uncertain original is never replaced or evicted. */
export function createSessionArchiveJournal(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}) {
  const read = () => {
    if (!deps.storage)
      throw Error("Original archive identity storage is unavailable.");
    const text = deps.storage.getItem(SESSION_ARCHIVE_JOURNAL);
    if (text === null) return schema.parse({ version: 1, records: [] });
    try {
      if (new TextEncoder().encode(text).length > MAX_ARCHIVE_JOURNAL_BYTES)
        throw Error("Full");
      const raw: unknown = JSON.parse(text);
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      /* Unknown saved identities never become an empty history. */
    }
    throw Error(
      "Original archive identities are invalid, full or unsupported. Saved data was kept.",
    );
  };
  const save = (state: z.infer<typeof schema>) => {
    const text = JSON.stringify(schema.parse(state));
    if (
      !deps.storage ||
      new TextEncoder().encode(text).length > MAX_ARCHIVE_JOURNAL_BYTES
    )
      throw Error(
        "Original archive identity storage is full or unavailable. Saved identities were kept.",
      );
    deps.storage.setItem(SESSION_ARCHIVE_JOURNAL, text);
    if (deps.storage.getItem(SESSION_ARCHIVE_JOURNAL) !== text)
      throw Error(
        "The original archive identity could not be saved and verified. No change was sent.",
      );
  };
  const selected = (
    records: SessionArchiveMarker[],
    expected: z.infer<typeof source>,
  ) => {
    const held = records.find(
      (record) => record.source.sessionId === expected.sessionId,
    );
    if (held && !equal(held.source, expected))
      throw Error(
        "A different original session still holds this archive identity. Saved data was kept.",
      );
    return held;
  };
  const verify = (raw: SessionArchiveMarker) => {
    const marker = markerSchema.parse(raw);
    const held = selected(read().records, marker.source);
    if (!held || !equal(held.original, marker.original) || held.settled)
      throw Error(
        "A different original archive change is held or this change is already confirmed.",
      );
    return structuredClone(held);
  };
  return {
    pending(record: OwnedCodingSessionRecord): SessionArchiveMarker | null {
      const held = selected(read().records, identity(record));
      return held && !held.settled ? structuredClone(held) : null;
    },
    verify,
    async reserve(
      record: OwnedCodingSessionRecord,
      input: Omit<SessionArchiveRequest, "requestId">,
      mint: () => string,
    ) {
      const expected = identity(record),
        draft = structuredClone(input);
      return deps.withLock(() => {
        const state = read(),
          held = selected(state.records, expected);
        if (held && !held.settled)
          return { created: false, marker: structuredClone(held) };
        if (!held && state.records.length >= 1000)
          throw Error(
            "Original archive identity storage is full. Uncertain changes were kept.",
          );
        const original = sessionArchiveRequestSchema.parse({
          ...draft,
          requestId: mint(),
        });
        if (
          state.records.some(
            (entry) => entry.original.requestId === original.requestId,
          )
        )
          throw Error(
            "The new archive UUID collides with another original change.",
          );
        const marker = markerSchema.parse({
          source: expected,
          original,
          settled: false,
        });
        save({
          version: 1,
          records: [...state.records.filter((entry) => entry !== held), marker],
        });
        return { created: true, marker: structuredClone(marker) };
      });
    },
    async settle(raw: SessionArchiveMarker, rawReceipt: SessionArchiveReceipt) {
      const marker = markerSchema.parse(raw),
        receipt = sessionArchiveReceiptSchema.parse(rawReceipt);
      if (
        receipt.projectId !== marker.source.projectId ||
        receipt.sessionId !== marker.source.sessionId ||
        receipt.startRequestId !== marker.source.startRequestId ||
        receipt.startRequestHash !== marker.source.startRequestHash ||
        !equal(receipt.original, marker.original)
      )
        throw Error(
          "The archive receipt does not match its exact original identity.",
        );
      return deps.withLock(() => {
        const state = read(),
          held = selected(state.records, marker.source);
        if (!held || !equal(held.original, marker.original))
          throw Error("A different original archive change is still held.");
        if (held.settled) return;
        held.settled = true;
        save(state);
      });
    },
  };
}
export type SessionArchiveJournal = ReturnType<
  typeof createSessionArchiveJournal
>;

import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  KeeperProposal,
  KeeperProposalDraft,
  KeeperProposalExecution,
  KeeperProposalJournal,
  KeeperProposalReceipt,
  KeeperProposalRecord,
} from "../../types/keeper-proposal";
import type {
  KeeperSessionStartIntent,
  KeeperSessionStartRequest,
} from "../../types/keeper-session-start";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartProposal,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import { ConversationError } from "../conversations/error";
import {
  conversationDirectory,
  conversationLeaseFile,
} from "../conversations/paths";
import { hashText } from "../hash-text";
import {
  ensurePrivateHome,
  MAX_SESSION_TRANSCRIPT_BYTES,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { canonicalSessionInput } from "../sessions/preparation";
import {
  keeperProposalDraftSchema,
  keeperProposalExecutionSchema,
  keeperProposalJournalSchema,
  keeperProposalRecordSchema,
  keeperProposalSchema,
} from "./proposal-protocol";
import {
  keeperSessionProposalIdSchema,
  keeperSessionStartIntentSchema,
  keeperSessionStartRequestSchema,
} from "./session-start-protocol";
import {
  keeperShiftProposalIdSchema,
  keeperShiftStartHashes,
  keeperShiftStartIntentSchema,
  keeperShiftStartRequestSchema,
  sameKeeperShiftStart,
} from "./shift-start-protocol";

type StoredJournal =
  | KeeperProposalJournal
  | (Omit<KeeperProposalJournal, "version"> & {
      version: 2;
      sessionStarts: KeeperSessionStartIntent[];
    })
  | (Omit<KeeperProposalJournal, "version"> & {
      version: 3;
      sessionStarts: KeeperSessionStartIntent[];
      shiftStarts: KeeperShiftStartIntent[];
    });
const journalV2 = z
  .object({
    version: z.literal(2),
    projectId: z.string().max(100),
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    records: z.array(keeperProposalRecordSchema).max(1000),
    sessionStarts: z.array(keeperSessionStartIntentSchema).max(1000),
  })
  .strict();
const journalV3 = z
  .object({
    version: z.literal(3),
    projectId: z.string().max(100),
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    records: z.array(keeperProposalRecordSchema).max(1000),
    sessionStarts: z.array(keeperSessionStartIntentSchema).max(1000),
    shiftStarts: z.array(keeperShiftStartIntentSchema).max(1000),
  })
  .strict();
export function keeperSessionStartHashes(
  projectId: string,
  proposalId: string,
  request: KeeperSessionStartRequest,
) {
  return {
    startHash: hashText(canonicalSessionInput(request.start)),
    reviewHash: hashText(
      canonicalSessionInput({
        kind: "keeper.session.start.v1",
        projectId,
        proposalId,
        sourceHash: request.sourceHash,
        start: request.start,
      }),
    ),
  };
}
const publicJournal = (state: StoredJournal): KeeperProposalJournal => ({
  version: 1,
  projectId: state.projectId,
  revision: state.revision,
  records: state.records,
});
function validSessionStarts(
  state: Pick<KeeperProposalJournal, "projectId" | "records"> & {
    sessionStarts: KeeperSessionStartIntent[];
  },
): boolean {
  return (
    new Set(state.sessionStarts.map((item) => item.proposalId)).size ===
      state.sessionStarts.length &&
    new Set(state.sessionStarts.map((item) => item.original.start.requestId))
      .size === state.sessionStarts.length &&
    state.sessionStarts.every((item) => {
      const record = state.records.find(
        (record) => record.id === item.proposalId,
      );
      const hashes = keeperSessionStartHashes(
        state.projectId,
        item.proposalId,
        item.original,
      );
      return (
        item.projectId === state.projectId &&
        !!record &&
        record.operation === "approve" &&
        record.draft.action.kind === "start-session" &&
        record.requestId === item.original.start.requestId &&
        record.sourceHash === item.original.sourceHash &&
        record.requestHash === item.reviewHash &&
        hashes.startHash === item.startHash &&
        hashes.reviewHash === item.reviewHash
      );
    })
  );
}
function parseJournal(value: unknown): StoredJournal | null {
  const legacy = keeperProposalJournalSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  const parsed = journalV2.safeParse(value);
  if (
    parsed.success &&
    keeperProposalJournalSchema.safeParse(publicJournal(parsed.data)).success
  ) {
    if (validSessionStarts(parsed.data)) return parsed.data;
    return null;
  }
  const shifted = journalV3.safeParse(value);
  if (
    !shifted.success ||
    !keeperProposalJournalSchema.safeParse(publicJournal(shifted.data)).success
  )
    return null;
  const stateV3 = shifted.data;
  const sessionRequests = stateV3.sessionStarts.map(
    (item) => item.original.start.requestId,
  );
  const shiftRequests = stateV3.shiftStarts.map(
    (item) => item.original.start.requestId,
  );
  if (
    !validSessionStarts(stateV3) ||
    new Set(stateV3.shiftStarts.map((item) => item.proposalId)).size !==
      stateV3.shiftStarts.length ||
    new Set(stateV3.shiftStarts.map((item) => item.original.start.requestId))
      .size !== stateV3.shiftStarts.length ||
    new Set([...sessionRequests, ...shiftRequests]).size !==
      sessionRequests.length + shiftRequests.length ||
    new Set([
      ...stateV3.sessionStarts.map((item) => item.proposalId),
      ...stateV3.shiftStarts.map((item) => item.proposalId),
    ]).size !==
      stateV3.sessionStarts.length + stateV3.shiftStarts.length ||
    stateV3.shiftStarts.some((item) => {
      const record = stateV3.records.find(
        (record) => record.id === item.proposalId,
      );
      const hashes = keeperShiftStartHashes(
        stateV3.projectId,
        item.proposalId,
        item.workspace,
        item.proposal,
        item.original,
      );
      return (
        item.projectId !== stateV3.projectId ||
        !record ||
        record.operation !== "approve" ||
        record.draft.action.kind !== "start-shift" ||
        record.requestId !== item.original.start.requestId ||
        record.sourceHash !== item.original.sourceHash ||
        record.requestHash !== item.reviewHash ||
        hashes.startHash !== item.startHash ||
        hashes.reviewHash !== item.reviewHash ||
        record.draft.action.durationMinutes !== item.proposal.durationMinutes ||
        record.draft.action.concurrency !== item.proposal.concurrency ||
        record.draft.action.beadLimit !== item.proposal.beadLimit ||
        record.draft.action.spendLimitUsd !== item.proposal.spendLimitUsd
      );
    })
  )
    return null;
  return stateV3;
}
interface SessionStartReviewInput {
  projectId: string;
  proposalId: string;
  request: KeeperSessionStartRequest;
  auditEventId: number;
}
interface SessionStartEffects {
  /** Runs only for new admission, inside the proposal lease, before any saved approval. */
  prepare(): Promise<{ proposal: KeeperProposal; workspace: string }>;
  execute(intent: KeeperSessionStartIntent): Promise<KeeperProposalExecution>;
}
interface ShiftStartReviewInput {
  projectId: string;
  proposalId: string;
  request: KeeperShiftStartRequest;
  auditEventId: number;
}
interface ShiftStartEffects {
  /** Reads and verifies the current Keeper source; it reserves and dispatches nothing. */
  prepare(): Promise<{ proposal: KeeperProposal; workspace: string }>;
  /** Called once, only after the full original and its identities are durable. */
  execute(intent: KeeperShiftStartIntent): Promise<KeeperProposalExecution>;
}

export function keeperProposalFile(home: string, projectId: string): string {
  return join(
    conversationDirectory(home, projectId),
    `keeper-${projectId}-proposals.json`,
  );
}
interface ReviewInput {
  projectId: string;
  proposal: KeeperProposal;
  requestId: string;
  expectedRevision: number;
  draft: KeeperProposalDraft;
  auditEventId: number;
}
const requestIdValid = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    id,
  );
const uncertain =
  "The action's completion is unknown. Inspect the current objects; this approval will not be dispatched again.";
const sessionUncertain =
  "The original session Start is unconfirmed. Check its private original request; it will not automatically repeat.";
const shiftUncertain =
  "The original Keeper Shift Start is unconfirmed. Check its private original request; it will not automatically repeat.";

/** Private approval admission is durable before business I/O; reads never dispatch. */
export function createKeeperProposalStore(
  home: string,
  now: () => Date = () => new Date(),
) {
  const inflight = new Set<string>();
  const lease = (projectId: string) =>
    join(
      dirname(conversationLeaseFile(home, projectId)),
      `${projectId}-proposals.db`,
    );
  const raw = (projectId: string): StoredJournal => {
    const found = readSessionTranscript(
      home,
      keeperProposalFile(home, projectId),
    );
    if (found.problem)
      throw new ConversationError(
        503,
        "The private proposal journal could not be read. Its saved data has been kept.",
      );
    if (found.text === null)
      return { version: 1, projectId, revision: 0, records: [] };
    let value: unknown;
    try {
      value = JSON.parse(found.text);
    } catch {
      throw new ConversationError(
        503,
        "The private proposal journal is invalid. Its saved data has been kept.",
      );
    }
    const parsed = parseJournal(value);
    if (!parsed || parsed.projectId !== projectId)
      throw new ConversationError(
        503,
        "The private proposal journal could not be verified. Its saved data has been kept.",
      );
    return parsed;
  };
  const save = (state: StoredJournal) => {
    const content = JSON.stringify(state);
    if (
      !parseJournal(state) ||
      Buffer.byteLength(content) > MAX_SESSION_TRANSCRIPT_BYTES
    )
      throw new ConversationError(
        503,
        "The private proposal journal is full or invalid. Its saved data has been kept.",
      );
    writeOwnerOnly(keeperProposalFile(home, state.projectId), content);
  };
  const read = async (projectId: string): Promise<KeeperProposalJournal> => {
    const state = raw(projectId);
    if (
      inflight.has(projectId) ||
      !state.records.some((record) => record.pending)
    )
      return publicJournal(state);
    const observed = await withQueueLock(
      lease(projectId),
      async () => raw(projectId),
      { waitMs: 25 },
    );
    if (!observed.ok) return publicJournal(state);
    return {
      ...publicJournal(observed.value),
      records: observed.value.records.map((record) =>
        record.pending
          ? {
              ...record,
              phase: "unknown",
              pending: false,
              message:
                observed.value.version === 2
                  ? observed.value.sessionStarts.some(
                      (item) => item.proposalId === record.id,
                    )
                    ? sessionUncertain
                    : uncertain
                  : observed.value.version === 3
                    ? observed.value.sessionStarts.some(
                        (item) => item.proposalId === record.id,
                      )
                      ? sessionUncertain
                      : observed.value.shiftStarts.some(
                            (item) => item.proposalId === record.id,
                          )
                        ? shiftUncertain
                        : uncertain
                    : uncertain,
            }
          : record,
      ),
    };
  };
  const readSessionStart = async (projectId: string, proposalId: string) => {
    const state = raw(projectId);
    const intent =
      state.version === 2 || state.version === 3
        ? state.sessionStarts.find((item) => item.proposalId === proposalId)
        : undefined;
    if (!intent) return null;
    const observed = await read(projectId);
    const record = observed.records.find((item) => item.id === proposalId);
    if (!record)
      throw new ConversationError(
        503,
        "The private session review could not be correlated. Its data has been kept.",
      );
    return { revision: observed.revision, record, intent };
  };
  const readShiftStart = async (projectId: string, proposalId: string) => {
    const state = raw(projectId);
    const intent =
      state.version === 3
        ? state.shiftStarts.find((item) => item.proposalId === proposalId)
        : undefined;
    if (!intent) return null;
    const observed = await read(projectId);
    const record = observed.records.find((item) => item.id === proposalId);
    if (!record)
      throw new ConversationError(
        503,
        "The private shift review could not be correlated. Its data has been kept.",
      );
    if (
      record.requestId !== intent.original.start.requestId ||
      record.sourceHash !== intent.original.sourceHash ||
      record.requestHash !== intent.reviewHash ||
      record.draft.action.kind !== "start-shift"
    )
      throw new ConversationError(
        503,
        "The private shift review does not match its saved original. Its data has been kept.",
      );
    return { revision: observed.revision, record, intent };
  };
  const startSession = async (
    input: SessionStartReviewInput,
    effects: SessionStartEffects,
  ) => {
    const request = keeperSessionStartRequestSchema.safeParse(input.request);
    if (
      !request.success ||
      !keeperSessionProposalIdSchema.safeParse(input.proposalId).success
    )
      throw new ConversationError(
        400,
        "Expected a strict original Keeper session Start.",
      );
    if (!Number.isSafeInteger(input.auditEventId) || input.auditEventId < 1)
      throw new ConversationError(
        503,
        "A session approval needs a confirmed operator audit row before admission.",
      );
    const original = request.data;
    const hashes = keeperSessionStartHashes(
      input.projectId,
      input.proposalId,
      original,
    );
    const existing = (state: StoredJournal) => {
      const record = state.records.find(
        (item) =>
          item.id === input.proposalId ||
          item.requestId === original.start.requestId,
      );
      if (!record) return null;
      const intent =
        state.version === 2 || state.version === 3
          ? state.sessionStarts.find((item) => item.proposalId === record.id)
          : undefined;
      if (
        !intent ||
        record.id !== input.proposalId ||
        record.requestId !== original.start.requestId
      )
        throw new ConversationError(
          409,
          "This proposal already has a recorded review. Inspect its original outcome.",
        );
      if (
        intent.reviewHash !== hashes.reviewHash ||
        canonicalSessionInput(intent.original) !==
          canonicalSessionInput(original)
      )
        throw new ConversationError(
          409,
          "This request already names different reviewed session content.",
        );
      return { record, intent };
    };
    const before = existing(raw(input.projectId));
    if (before?.record.phase === "done")
      return { revision: (await read(input.projectId)).revision, ...before };
    ensurePrivateHome(home);
    inflight.add(input.projectId);
    try {
      const locked = await withQueueLock(
        lease(input.projectId),
        async () => {
          let state = raw(input.projectId);
          let prior = existing(state);
          if (!prior) {
            if (state.records.length >= 1000)
              throw new ConversationError(
                503,
                "The private proposal journal is full. Its original reviews have been kept.",
              );
            if (state.revision !== original.expectedRevision)
              throw new ConversationError(
                409,
                "Proposal review changed. Read it again before starting.",
              );
            const prepared = await effects.prepare();
            const source = keeperProposalSchema.safeParse(prepared.proposal);
            if (
              !source.success ||
              source.data.projectId !== input.projectId ||
              source.data.id !== input.proposalId ||
              source.data.sourceHash !== original.sourceHash ||
              source.data.draft.action.kind !== "start-session"
            )
              throw new ConversationError(
                409,
                "The original session proposal source could not be verified.",
              );
            const intent = keeperSessionStartIntentSchema.parse({
              projectId: input.projectId,
              proposalId: input.proposalId,
              workspace: prepared.workspace,
              original,
              ...hashes,
              createdAt: now().toISOString(),
            });
            const record: KeeperProposalRecord = {
              ...source.data,
              requestId: original.start.requestId,
              requestHash: hashes.reviewHash,
              operation: "approve",
              auditEventId: input.auditEventId,
              phase: "approved",
              pending: true,
              updatedAt: now().toISOString(),
              message:
                "Session approval recorded. The original Start is awaiting confirmation.",
              objects: [],
            };
            state =
              state.version === 3
                ? { ...state, sessionStarts: state.sessionStarts }
                : {
                    ...state,
                    version: 2,
                    sessionStarts:
                      state.version === 2 ? state.sessionStarts : [],
                  };
            state.records.push(record);
            state.sessionStarts.push(intent);
            state.revision++;
            save(state);
            prior = { record, intent };
          } else if (prior.record.phase === "done")
            return { revision: state.revision, ...prior };
          else {
            Object.assign(prior.record, {
              phase: "approved",
              pending: true,
              updatedAt: now().toISOString(),
            });
            state.revision++;
            save(state);
          }
          let outcome: KeeperProposalExecution;
          try {
            const parsed = keeperProposalExecutionSchema.safeParse(
              await effects.execute(structuredClone(prior.intent)),
            );
            outcome = parsed.success
              ? parsed.data
              : { phase: "unknown", message: sessionUncertain, objects: [] };
          } catch {
            outcome = {
              phase: "unknown",
              message: sessionUncertain,
              objects: [],
            };
          }
          Object.assign(prior.record, outcome, {
            pending: false,
            updatedAt: now().toISOString(),
          });
          state.revision++;
          save(state);
          return { revision: state.revision, ...prior };
        },
        { waitMs: 300 },
      );
      if (!locked.ok) {
        const observed = await readSessionStart(
          input.projectId,
          input.proposalId,
        );
        if (observed && existing(raw(input.projectId))) return observed;
        throw new ConversationError(
          409,
          "Session review is busy. Check the original Start before retrying.",
        );
      }
      return locked.value;
    } finally {
      inflight.delete(input.projectId);
    }
  };
  const startShift = async (
    input: ShiftStartReviewInput,
    effects: ShiftStartEffects,
  ) => {
    const request = keeperShiftStartRequestSchema.safeParse(input.request);
    if (
      !request.success ||
      !keeperShiftProposalIdSchema.safeParse(input.proposalId).success
    )
      throw new ConversationError(
        400,
        "Expected the complete original Keeper project Shift Start.",
      );
    if (!Number.isSafeInteger(input.auditEventId) || input.auditEventId < 1)
      throw new ConversationError(
        503,
        "A Keeper Shift Start needs a confirmed operator audit row before admission.",
      );
    const original = request.data;
    const existing = (state: StoredJournal) => {
      const record = state.records.find(
        (item) =>
          item.id === input.proposalId ||
          item.requestId === original.start.requestId,
      );
      if (!record) return null;
      const intent =
        state.version === 3
          ? state.shiftStarts.find((item) => item.proposalId === record.id)
          : undefined;
      if (
        !intent ||
        record.id !== input.proposalId ||
        record.requestId !== original.start.requestId ||
        record.sourceHash !== original.sourceHash ||
        record.requestHash !== intent.reviewHash ||
        record.draft.action.kind !== "start-shift" ||
        record.draft.action.durationMinutes !==
          intent.proposal.durationMinutes ||
        record.draft.action.concurrency !== intent.proposal.concurrency ||
        record.draft.action.beadLimit !== intent.proposal.beadLimit ||
        record.draft.action.spendLimitUsd !== intent.proposal.spendLimitUsd
      )
        throw new ConversationError(
          409,
          "This proposal or original request already has a different review. Inspect its saved outcome.",
        );
      const hashes = keeperShiftStartHashes(
        input.projectId,
        input.proposalId,
        intent.workspace,
        intent.proposal,
        original,
      );
      const candidate = {
        ...intent,
        original,
        ...hashes,
      };
      if (
        intent.projectId !== input.projectId ||
        !sameKeeperShiftStart(intent, candidate)
      )
        throw new ConversationError(
          409,
          "This request already names different reviewed Keeper Shift content.",
        );
      return { record, intent };
    };
    const before = existing(raw(input.projectId));
    if (before) {
      const original = await readShiftStart(input.projectId, input.proposalId);
      if (!original)
        throw new ConversationError(
          503,
          "The original Keeper Shift Start could not be read. Its data has been kept.",
        );
      return original;
    }
    ensurePrivateHome(home);
    inflight.add(input.projectId);
    try {
      const locked = await withQueueLock(
        lease(input.projectId),
        async () => {
          const state = raw(input.projectId);
          const prior = existing(state);
          if (prior) return { revision: state.revision, ...prior };
          if (state.records.length >= 1000)
            throw new ConversationError(
              503,
              "The private proposal journal is full. Its original reviews have been kept.",
            );
          if (state.revision !== original.expectedRevision)
            throw new ConversationError(
              409,
              "Proposal review changed. Read it again before starting a Shift.",
            );
          const prepared = await effects.prepare();
          const source = keeperProposalSchema.safeParse(prepared.proposal);
          if (
            !source.success ||
            source.data.projectId !== input.projectId ||
            source.data.id !== input.proposalId ||
            source.data.sourceHash !== original.sourceHash ||
            source.data.draft.action.kind !== "start-shift"
          )
            throw new ConversationError(
              409,
              "The original Keeper Shift proposal source could not be verified.",
            );
          const proposal: KeeperShiftStartProposal = {
            durationMinutes: source.data.draft.action.durationMinutes,
            concurrency: source.data.draft.action.concurrency,
            beadLimit: source.data.draft.action.beadLimit,
            spendLimitUsd: source.data.draft.action.spendLimitUsd,
          };
          const hashes = keeperShiftStartHashes(
            input.projectId,
            input.proposalId,
            prepared.workspace,
            proposal,
            original,
          );
          const checkedIntent = keeperShiftStartIntentSchema.safeParse({
            projectId: input.projectId,
            proposalId: input.proposalId,
            workspace: prepared.workspace,
            proposal,
            original,
            ...hashes,
            createdAt: now().toISOString(),
          });
          if (!checkedIntent.success)
            throw new ConversationError(
              400,
              "The original Keeper Shift review could not be saved.",
            );
          const intent = checkedIntent.data;
          const record: KeeperProposalRecord = {
            ...source.data,
            requestId: original.start.requestId,
            requestHash: hashes.reviewHash,
            operation: "approve",
            auditEventId: input.auditEventId,
            phase: "approved",
            pending: true,
            updatedAt: now().toISOString(),
            message:
              "Shift approval recorded. The original Start is awaiting confirmation.",
            objects: [],
          };
          const next: Extract<StoredJournal, { version: 3 }> = {
            version: 3,
            projectId: state.projectId,
            revision: state.revision,
            records: state.records,
            sessionStarts: state.version === 1 ? [] : state.sessionStarts,
            shiftStarts: state.version === 3 ? state.shiftStarts : [],
          };
          next.records.push(record);
          next.shiftStarts.push(intent);
          next.revision++;
          save(next);
          let outcome: KeeperProposalExecution;
          try {
            const parsed = keeperProposalExecutionSchema.safeParse(
              await effects.execute(structuredClone(intent)),
            );
            outcome = parsed.success
              ? parsed.data
              : { phase: "unknown", message: shiftUncertain, objects: [] };
          } catch {
            outcome = {
              phase: "unknown",
              message: shiftUncertain,
              objects: [],
            };
          }
          Object.assign(record, outcome, {
            pending: false,
            updatedAt: now().toISOString(),
          });
          next.revision++;
          save(next);
          return { revision: next.revision, record, intent };
        },
        { waitMs: 300 },
      );
      if (!locked.ok) {
        const observed = await readShiftStart(
          input.projectId,
          input.proposalId,
        );
        if (observed && existing(raw(input.projectId))) return observed;
        throw new ConversationError(
          409,
          "Keeper Shift review is busy. Check the original Start before trying again.",
        );
      }
      return locked.value;
    } finally {
      inflight.delete(input.projectId);
    }
  };
  const change = async (
    input: ReviewInput,
    operation: "approve" | "dismiss",
    execute?: () => Promise<KeeperProposalExecution>,
  ): Promise<KeeperProposalReceipt> => {
    const source = keeperProposalSchema.safeParse(input.proposal),
      draft = keeperProposalDraftSchema.safeParse(
        operation === "dismiss" ? input.proposal.draft : input.draft,
      );
    if (!source.success || source.data.projectId !== input.projectId)
      throw new ConversationError(
        400,
        "Expected this project's verified source proposal.",
      );
    if (
      !draft.success ||
      !requestIdValid(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new ConversationError(
        400,
        "Expected a bounded reviewed proposal and request identity.",
      );
    if (!Number.isSafeInteger(input.auditEventId) || input.auditEventId < 1)
      throw new ConversationError(
        503,
        "An approval needs a confirmed operator audit row before admission.",
      );
    const requestHash = hashText(
      JSON.stringify({
        operation,
        sourceHash: source.data.sourceHash,
        draft: draft.data,
      }),
    );
    const existing = (
      state: Pick<KeeperProposalJournal, "records" | "revision">,
    ): KeeperProposalReceipt | null => {
      const byRequest = state.records.find(
        (record) => record.requestId === input.requestId,
      );
      if (byRequest) {
        if (
          byRequest.id !== source.data.id ||
          byRequest.requestHash !== requestHash ||
          byRequest.sourceHash !== source.data.sourceHash
        )
          throw new ConversationError(
            409,
            "This request already names different reviewed content.",
          );
        return {
          projectId: input.projectId,
          revision: state.revision,
          record: byRequest,
        };
      }
      if (state.records.some((record) => record.id === source.data.id))
        throw new ConversationError(
          409,
          "This proposal already has a recorded review. Inspect its original outcome.",
        );
      return null;
    };
    const previous = existing(await read(input.projectId));
    if (previous) return previous;
    ensurePrivateHome(home);
    inflight.add(input.projectId);
    try {
      const locked = await withQueueLock(
        lease(input.projectId),
        async () => {
          const state = raw(input.projectId),
            prior = existing(state);
          if (prior) return prior;
          if (state.revision !== input.expectedRevision)
            throw new ConversationError(
              409,
              "Proposal review changed. Read it again before approving.",
            );
          const record: KeeperProposalRecord = {
            ...source.data,
            draft: draft.data,
            requestId: input.requestId,
            requestHash,
            operation,
            auditEventId: input.auditEventId,
            phase: operation === "dismiss" ? "dismissed" : "approved",
            pending: operation === "approve",
            updatedAt: now().toISOString(),
            message:
              operation === "dismiss"
                ? "Dismissed. Nothing was executed."
                : "Approval recorded. Waiting for the action's confirmed outcome.",
            objects: [],
          };
          state.records.push(record);
          state.revision++;
          save(state);
          if (operation === "approve") {
            let outcome: KeeperProposalExecution;
            try {
              const parsed = keeperProposalExecutionSchema.safeParse(
                await execute?.(),
              );
              outcome = parsed.success
                ? parsed.data
                : { phase: "unknown", message: uncertain, objects: [] };
            } catch {
              outcome = { phase: "unknown", message: uncertain, objects: [] };
            }
            Object.assign(record, outcome, {
              pending: false,
              updatedAt: now().toISOString(),
            });
            state.revision++;
            save(state);
          }
          return {
            projectId: input.projectId,
            revision: state.revision,
            record,
          };
        },
        { waitMs: 300 },
      );
      if (!locked.ok)
        throw new ConversationError(
          409,
          "Proposal review is busy. Read the original outcome before retrying.",
        );
      return locked.value;
    } finally {
      inflight.delete(input.projectId);
    }
  };
  return {
    read,
    readSessionStart,
    readShiftStart,
    startSession,
    startShift,
    approve: (
      input: ReviewInput,
      execute: () => Promise<KeeperProposalExecution>,
    ) => change(input, "approve", execute),
    dismiss: (input: ReviewInput) => change(input, "dismiss"),
  };
}

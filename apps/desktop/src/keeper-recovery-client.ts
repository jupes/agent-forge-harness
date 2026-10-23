import type { ActionOutcome } from "../../../docs/js/action-outcome";
import {
  keeperContinuationRecordSchema,
  keeperRecoveryPageSchema,
} from "../../../scripts/keeper/recovery-protocol";
import type {
  KeeperContinuationRecord,
  KeeperContinuationRequest,
  KeeperRecoveryPage,
} from "../../../types/keeper-recovery";

export interface KeeperRecoveryView {
  page: KeeperRecoveryPage | null;
  loading: boolean;
  pending: KeeperContinuationRequest | null;
  posting: boolean;
  notice: string;
  confirmed: KeeperContinuationRecord | null;
}
const same = (
  record: KeeperContinuationRecord,
  input: KeeperContinuationRequest,
) =>
  record.requestId === input.requestId &&
  record.expectedRevision === input.expectedRevision &&
  record.mode === input.mode &&
  record.smith === input.smith &&
  record.summary === input.summary;

/** App-root owner for frozen continuation intent and its explicit retry. Reads never switch. */
export function createKeeperRecoveryClient(deps: {
  read(id: string, requestId?: string): Promise<unknown>;
  post(id: string, input: KeeperContinuationRequest): Promise<ActionOutcome>;
  requestId(): string;
  canChange(id: string): boolean;
  revision(id: string): number;
  changed(): void;
  confirmed(id: string): void;
}) {
  const entries = new Map<string, KeeperRecoveryView>();
  const reads = new Map<string, { promise: Promise<void>; again: boolean }>();
  const versions = new Map<string, number>();
  let disposed = false;
  const get = (id: string) => {
    let value = entries.get(id);
    if (!value) {
      value = {
        page: null,
        loading: false,
        pending: null,
        posting: false,
        notice: "",
        confirmed: null,
      };
      entries.set(id, value);
    }
    return value;
  };
  const confirm = (id: string, record: KeeperContinuationRecord) => {
    const entry = get(id);
    if (!entry.pending)
      return (
        entry.confirmed?.requestId === record.requestId &&
        same(record, entry.confirmed)
      );
    if (!same(record, entry.pending)) return false;
    entry.pending = null;
    entry.confirmed = record;
    entry.notice = record.resumed
      ? "Smith changed. The same provider conversation and saved history are retained. No turn was started."
      : "New provider conversation prepared. The reviewed summary and saved history are retained. No turn was started.";
    deps.confirmed(id);
    return true;
  };
  const read = (id: string): Promise<void> => {
    const running = reads.get(id);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const entry = get(id);
    const version = versions.get(id) ?? 0;
    entry.loading = true;
    deps.changed();
    const pendingRead = { promise: Promise.resolve(), again: false };
    reads.set(id, pendingRead);
    const current = () => !disposed && (versions.get(id) ?? 0) === version;
    pendingRead.promise = (async () => {
      try {
        const parsed = keeperRecoveryPageSchema.safeParse(
          await deps.read(id, entry.pending?.requestId),
        );
        if (!current()) return;
        if (
          !parsed.success ||
          parsed.data.projectId !== id ||
          parsed.data.choices.some(
            ({ readiness, smith }) =>
              readiness.canStart &&
              (!smith.enabled ||
                readiness.connection === "signed-out" ||
                readiness.connection === "adapter-missing" ||
                readiness.allowance === "exhausted"),
          )
        )
          throw new Error("Unverified recovery page");
        if (
          !entry.page ||
          parsed.data.conversationRevision >= entry.page.conversationRevision
        )
          entry.page = parsed.data;
        if (
          parsed.data.request &&
          parsed.data.request.revision <= parsed.data.conversationRevision
        )
          confirm(id, parsed.data.request);
      } catch {
        if (current())
          entry.notice =
            "The Keeper readiness report could not be verified. Its last confirmed selection and history have been kept; recheck readiness.";
      } finally {
        if (reads.get(id) === pendingRead) reads.delete(id);
        if (current()) {
          entry.loading = false;
          deps.changed();
          if (pendingRead.again) void read(id);
        }
      }
    })();
    return pendingRead.promise;
  };
  const post = async (id: string, retry: boolean) => {
    const entry = get(id),
      input = entry.pending;
    if (disposed || !input || entry.posting) return;
    entry.posting = true;
    entry.notice = "Sending the original Keeper change…";
    deps.changed();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(id, input);
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The Keeper change outcome is unknown. Check the original request before changing it again.",
      };
    }
    if (disposed) return;
    entry.posting = false;
    if (outcome.state === "done") {
      const parsed = keeperContinuationRecordSchema.safeParse(outcome.data);
      if (!parsed.success || !confirm(id, parsed.data))
        entry.notice =
          "The Keeper change receipt could not be verified. Check the original request.";
    } else if (!entry.confirmed || !same(entry.confirmed, input)) {
      // A later refusal cannot disprove an earlier request whose delivery is unknown.
      entry.notice = outcome.message;
      if (outcome.state === "refused" && !retry) entry.pending = null;
    }
    deps.changed();
    await read(id);
  };
  return {
    get,
    read,
    canChange: (id: string) =>
      !disposed && !get(id).pending && !get(id).posting && deps.canChange(id),
    canStart(id: string) {
      const entry = get(id),
        selected = entry.page?.choices.find(
          ({ smith }) => smith.name === entry.page?.selectedSmith,
        );
      return (
        !disposed &&
        !entry.pending &&
        !entry.posting &&
        selected?.readiness.canStart === true
      );
    },
    async change(
      id: string,
      input: Pick<KeeperContinuationRequest, "mode" | "smith" | "summary">,
    ) {
      const entry = get(id);
      if (disposed || entry.pending || entry.posting || !deps.canChange(id))
        return;
      const selected = entry.page?.choices.find(
        ({ smith }) => smith.name === input.smith,
      );
      if (!selected?.smith.enabled || !selected.readiness.canStart) return;
      entry.pending = {
        ...input,
        requestId: deps.requestId(),
        expectedRevision: deps.revision(id),
      };
      await post(id, false);
    },
    retry: (id: string) =>
      deps.canChange(id) ? post(id, true) : Promise.resolve(),
    release(id: string) {
      versions.set(id, (versions.get(id) ?? 0) + 1);
      reads.delete(id);
      get(id).page = null;
      get(id).confirmed = null;
      get(id).loading = false;
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}

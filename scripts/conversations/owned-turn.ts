import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type {
  ConversationEvent,
  ConversationReceipt,
  OwnedConversationAddress,
  PreparedConversationSend,
} from "../../types/conversation";
import { ensurePrivateHome } from "../hearth/home-guard";
import { withQueueLock } from "../scheduler/queue-lock";
import { parseOwnedPreparedConversationSend } from "../sessions/codex-owned-journal";
import { ConversationError } from "./error";
import { conversationLeaseFile } from "./paths";
import { createConversationStore } from "./store";

type Outcome = {
  phase: "completed" | "failed" | "cancelled" | "unknown";
  reason: string | null;
};
const interrupted: Outcome = {
  phase: "unknown",
  reason: "The private turn owner was interrupted. Its input was not resent.",
};

/** One fresh owned attempt. The existing private store and whole-turn SQLite lease own its lifecycle. */
export async function openOwnedConversationTurn(options: {
  home: string;
  address: OwnedConversationAddress;
  input: PreparedConversationSend;
  signal: AbortSignal;
}) {
  const address = structuredClone(options.address),
    projectId = address.projectId;
  const input = parseOwnedPreparedConversationSend(options.input);
  const store = createConversationStore(options.home, undefined, address);
  const lease = conversationLeaseFile(options.home, projectId, address);
  ensurePrivateHome(options.home);
  try {
    const found = lstatSync(lease);
    if (!found.isFile() || found.isSymbolicLink() || found.nlink !== 1)
      throw new ConversationError(
        503,
        "The private turn lease is linked or unavailable.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const owner = randomUUID();
  let current = !options.signal.aborted,
    abandoned = options.signal.aborted,
    dispatched = false,
    exited = false;
  let outcome: Outcome | null = null;
  let wake: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  let admit: (receipt: ConversationReceipt) => void = () => {};
  let refuse: (error: unknown) => void = () => {};
  const admitted = new Promise<ConversationReceipt>((resolve, reject) => {
    admit = resolve;
    refuse = reject;
  });
  const abort = () => {
    abandoned = true;
    current = false;
    // A failed writer cannot release ownership while a provider tree is live.
    if (!dispatched || exited) {
      outcome = interrupted;
      wake();
    }
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const active = () => current && !options.signal.aborted;
  const job = withQueueLock(
    lease,
    async () => {
      let accepted = false,
        started = false;
      try {
        if (!active())
          throw new ConversationError(
            409,
            "The private turn owner is no longer active.",
          );
        const existing = store.read(projectId);
        if (existing.turns.length || existing.frames.length)
          throw new ConversationError(
            409,
            "The original private attempt already exists. It will not be dispatched again.",
          );
        const receipt = await store.accept(projectId, input, active);
        accepted = true;
        await store.start(projectId, input.requestId, owner, active);
        started = true;
        admit({
          ...receipt,
          revision: store.read(projectId).revision,
          turn: store.read(projectId).turns[0] ?? receipt.turn,
        });
        await completed;
        current = false;
        const terminal = outcome ?? interrupted;
        await store.finish(
          projectId,
          input.requestId,
          owner,
          terminal.phase,
          terminal.reason,
          () => !abandoned && !options.signal.aborted,
        );
      } catch (error) {
        current = false;
        if (accepted && !started) {
          const saved = store
            .read(projectId)
            .turns.find((row) => row.requestId === input.requestId);
          if (saved?.phase === "accepted")
            await store.requestStop(projectId, input.requestId);
        }
        throw error;
      }
    },
    { waitMs: 300 },
  )
    .then((result) => {
      if (!result.ok)
        throw new ConversationError(
          409,
          "Another private turn owner holds this attempt.",
        );
    })
    .finally(() => {
      current = false;
      options.signal.removeEventListener("abort", abort);
    });
  // Admission may fail before a handle is returned. Always consume that job's rejection.
  void job.catch(refuse);
  const receipt = await admitted;
  return {
    receipt,
    done: job,
    append(event: Exclude<ConversationEvent, { kind: "user" }>) {
      if (!active())
        return Promise.reject(
          new ConversationError(
            409,
            "The private turn owner is no longer active.",
          ),
        );
      return store.append(projectId, input.requestId, owner, event, active);
    },
    processStarted() {
      if (!active())
        throw new ConversationError(
          409,
          "The private turn owner is no longer active.",
        );
      dispatched = true;
    },
    processExited() {
      exited = true;
      if (!active()) abort();
    },
    abort,
    async finish(terminal: Outcome) {
      if (dispatched && !exited)
        throw new ConversationError(
          409,
          "The supervised process tree has not exited.",
        );
      if (!outcome) outcome = active() ? terminal : interrupted;
      current = false;
      wake();
      await job;
    },
  };
}

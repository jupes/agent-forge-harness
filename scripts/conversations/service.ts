import { randomUUID } from "node:crypto";
import type {
  ConversationObject,
  ConversationPage,
  ConversationReceipt,
  ConversationSend,
  ConversationState,
  ConversationTurn,
  PreparedConversationSend,
} from "../../types/conversation";
import type { KeeperBriefSnapshot } from "../../types/keeper-brief";
import { keeperBriefPrompt, keeperBriefs } from "../keeper/brief-model";
import { briefSnapshotSchema } from "../keeper/brief-protocol";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { conversationLeaseFile } from "./paths";
import {
  ConversationError,
  createConversationStore,
  interruptedConversation,
  parseConversationSend,
} from "./store";
import type { ConversationTransport, ConversationUpdate } from "./transport";

export type { ConversationPage } from "../../types/conversation";

export type ValidateConversationAbout = (
  projectId: string,
  about: ConversationObject[],
) => Promise<void>;

interface ConversationOptions {
  home: string;
  root: string;
  transport: ConversationTransport;
  validateAbout?: ValidateConversationAbout | undefined;
  prepareBrief?:
    | ((projectId: string) => Promise<KeeperBriefSnapshot>)
    | undefined;
  onChange?(update: ConversationUpdate): void;
}

const activePhase = (phase: string) =>
  ["accepted", "running", "cancelling"].includes(phase);

/** Observers do not own provider lifetime. A held SQLite lease fences dispatch across hearths. */
export function createConversationService(options: ConversationOptions) {
  const store = createConversationStore(options.home);
  const workspace = resolveCheckout(options.root).workspace;
  const jobs = new Map<
    string,
    {
      job: Promise<void>;
      abort: AbortController;
      requestId: string;
      admission: Promise<ConversationReceipt>;
    }
  >();
  const owned = new Set<string>();
  let closed = false;
  const projectFor = (projectId: string) => {
    // Validates the address before it can participate in a filename.
    store.read(projectId);
    const project = createProjectStore(options.home)
      .read()
      .projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    return project;
  };
  const leaseFor = (projectId: string) =>
    conversationLeaseFile(options.home, projectId);
  const receipt = (
    state: ConversationState,
    requestId: string,
  ): ConversationReceipt => {
    const turn = state.turns.find((item) => item.requestId === requestId);
    if (!turn)
      throw new ConversationError(
        404,
        "This request is not in the conversation.",
      );
    return {
      conversationId: state.conversationId,
      revision: state.revision,
      turn,
    };
  };
  const notify = (projectId: string, requestId: string) => {
    const current = receipt(store.read(projectId), requestId);
    try {
      options.onChange?.({
        projectId,
        conversationId: current.conversationId,
        revision: current.revision,
        requestId,
        phase: current.turn.phase,
      });
    } catch {
      /* A failed metadata projection never repeats a turn. */
    }
  };
  const observe = async (projectId: string) => {
    projectFor(projectId);
    let state = store.read(projectId);
    if (
      !jobs.has(projectId) &&
      state.turns.some((item) => activePhase(item.phase))
    ) {
      const observed = await withQueueLock(
        leaseFor(projectId),
        async () => store.read(projectId),
        { waitMs: 150 },
      );
      state = observed.ok
        ? interruptedConversation(observed.value)
        : store.read(projectId);
    }
    return state;
  };
  return {
    async briefs(projectId: string) {
      return keeperBriefs(await observe(projectId));
    },
    async read(
      projectId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ): Promise<ConversationPage> {
      const after = query.after ?? 0;
      const limit = query.limit ?? 100;
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new ConversationError(
          400,
          "Expected a nonnegative cursor and a page size from 1 to 100.",
        );
      const state = await observe(projectId);
      const frames = state.frames
        .filter((frame) => frame.seq > after)
        .slice(0, limit);
      const nextCursor = frames.at(-1)?.seq ?? after;
      return {
        ...state,
        turns: state.turns.slice(-50),
        frames,
        more: state.frames.some((frame) => frame.seq > nextCursor),
        nextCursor,
        lastSequence: state.frames.at(-1)?.seq ?? 0,
        request:
          state.turns.find((item) => item.requestId === query.requestId) ??
          null,
        controllable: owned.has(projectId),
      };
    },
    async send(
      projectId: string,
      rawInput: ConversationSend,
      purpose: "message" | "brief" = "message",
    ): Promise<ConversationReceipt> {
      const wireInput = parseConversationSend(rawInput);
      let input: PreparedConversationSend = wireInput;
      const project = projectFor(projectId);
      const current = store.read(projectId);
      const original = () => {
        const user = store
          .read(projectId)
          .frames.find(
            (frame) =>
              frame.turnId === input.requestId && frame.event.kind === "user",
          )?.event;
        if (purpose !== "brief") return wireInput;
        if (user?.kind !== "user" || !user.brief)
          throw new ConversationError(
            409,
            "This request id already names different content. Read the original request.",
          );
        return { ...wireInput, brief: user.brief };
      };
      if (current.turns.some((item) => item.requestId === input.requestId))
        return store.accept(projectId, original());
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No turn was accepted.",
        );
      if (
        !project.workspaces.some(
          (scope) => workspaceKey(scope.root) === workspaceKey(workspace),
        )
      )
        throw new ConversationError(
          409,
          "This hearth does not serve this project's workspace. No turn was accepted.",
        );
      if (
        current.binding &&
        current.binding.provider !== options.transport.provider
      )
        throw new ConversationError(
          409,
          "The configured provider differs from the saved conversation. Continuity must be resolved before sending.",
        );
      if (input.about.length) {
        if (!options.validateAbout)
          throw new ConversationError(
            400,
            "Object context requires the project-scoped reader. No turn was accepted.",
          );
        await options.validateAbout(projectId, input.about);
      }
      if (purpose === "brief" && !options.prepareBrief)
        throw new ConversationError(
          503,
          "Brief source preparation is unavailable. No turn was accepted.",
        );
      await options.transport.check?.({
        project,
        root: options.root,
        resume: current.binding,
      });
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No turn was accepted.",
        );
      const existing = jobs.get(projectId);
      if (existing) {
        if (existing.requestId !== input.requestId)
          throw new ConversationError(
            409,
            "This hearth already owns an active turn. No new turn was accepted.",
          );
        await existing.admission;
        return store.accept(projectId, original());
      }
      const abort = new AbortController();
      const owner = randomUUID();
      let admitted = false;
      let accept: (value: ConversationReceipt) => void = () => {};
      let refuse: (error: unknown) => void = () => {};
      const answer = new Promise<ConversationReceipt>((resolve, reject) => {
        accept = resolve;
        refuse = reject;
      });
      const job = (async () => {
        const locked = await withQueueLock(
          leaseFor(projectId),
          async () => {
            if (closed || abort.signal.aborted)
              throw new ConversationError(
                503,
                "This hearth is closing. No turn was accepted.",
              );
            await store.recover(projectId);
            // Preflight can take time. Recheck new context at admission; exact
            // retries always reconcile their saved receipt without fresh authority.
            if (
              input.about.length &&
              !store
                .read(projectId)
                .turns.some((turn) => turn.requestId === input.requestId)
            )
              await options.validateAbout?.(projectId, input.about);
            if (purpose === "brief") {
              if (
                store
                  .read(projectId)
                  .turns.some((turn) => turn.requestId === input.requestId)
              )
                input = original();
              else {
                const snapshot = briefSnapshotSchema.safeParse(
                  await options.prepareBrief?.(projectId),
                );
                if (!snapshot.success || snapshot.data.projectId !== projectId)
                  throw new ConversationError(
                    503,
                    "The scoped brief snapshot could not be verified. No turn was accepted.",
                  );
                input = { ...wireInput, brief: snapshot.data };
              }
            }
            if (closed || abort.signal.aborted)
              throw new ConversationError(
                503,
                "The hearth closed during source preparation. No turn was accepted.",
              );
            const accepted = await store.accept(projectId, input);
            if (accepted.turn.phase !== "accepted") {
              admitted = true;
              accept(accepted);
              return;
            }
            await store.start(projectId, input.requestId, owner);
            owned.add(projectId);
            admitted = true;
            accept(receipt(store.read(projectId), input.requestId));
            notify(projectId, input.requestId);
            try {
              const result = await options.transport.run(
                {
                  project,
                  root: options.root,
                  input: input.brief
                    ? { ...input, text: keeperBriefPrompt(input.brief) }
                    : input,
                  resume: store.read(projectId).binding,
                },
                async (event) => {
                  await store.append(projectId, input.requestId, owner, event);
                  notify(projectId, input.requestId);
                },
                abort.signal,
              );
              await store.finish(
                projectId,
                input.requestId,
                owner,
                abort.signal.aborted ? "cancelled" : result.phase,
                result.reason,
              );
            } catch {
              // Dispatch may already have reached the provider. Preserve partial output and uncertainty.
              await store.finish(
                projectId,
                input.requestId,
                owner,
                abort.signal.aborted ? "cancelled" : "unknown",
                abort.signal.aborted
                  ? "The supervised turn was stopped."
                  : "The provider did not report a confirmed outcome. This turn was not resent.",
              );
            }
            notify(projectId, input.requestId);
          },
          { waitMs: 300 },
        );
        if (!locked.ok) {
          if (
            store
              .read(projectId)
              .turns.some((turn) => turn.requestId === input.requestId)
          ) {
            const previous = await store.accept(projectId, original());
            admitted = true;
            accept(previous);
          } else
            throw new ConversationError(
              409,
              "Another hearth owns an active turn. No new turn was accepted.",
            );
        }
      })()
        .catch((error) => {
          if (!admitted) refuse(error);
        })
        .finally(() => {
          if (jobs.get(projectId)?.abort === abort) {
            jobs.delete(projectId);
            owned.delete(projectId);
          }
        });
      jobs.set(projectId, {
        job,
        abort,
        requestId: input.requestId,
        admission: answer,
      });
      return answer;
    },
    async stop(
      projectId: string,
      requestId: string,
    ): Promise<ConversationReceipt> {
      projectFor(projectId);
      const before = receipt(store.read(projectId), requestId);
      const active = jobs.get(projectId);
      if (
        ["running", "cancelling"].includes(before.turn.phase) &&
        (!owned.has(projectId) || active?.requestId !== requestId)
      )
        throw new ConversationError(
          409,
          "This hearth does not own the turn's process. It has not confirmed a stop.",
        );
      if (!activePhase(before.turn.phase)) return before;
      await store.requestStop(projectId, requestId);
      active?.abort.abort();
      notify(projectId, requestId);
      return receipt(store.read(projectId), requestId);
    },
    async settled(projectId: string) {
      await jobs.get(projectId)?.job;
    },
    async close() {
      closed = true;
      for (const { abort } of jobs.values()) abort.abort();
      await Promise.all([...jobs.values()].map((item) => item.job));
    },
  };
}

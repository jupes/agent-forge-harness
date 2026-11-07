import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import type { ConversationState } from "../../types/conversation";
import type { ProjectRecord } from "../../types/projects";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { readProjectCouncilInventory } from "../council/project-original-store";
import { readProjectCheckpointReviewInventory } from "../forge/project-checkpoint-review-store";
import { readHomeFile, readSessionTranscript } from "../hearth/home-guard";
import { readRestartIdentityInventory } from "../identities/restart-index";
import { createKeeperProposalStore } from "../keeper/proposal-store";
import { readCodexChatForkInventory } from "../sessions/codex-chat-fork-journal";
import { createSessionRegistry } from "../sessions/registry";
import { readTerminalHandoffInventory } from "../sessions/terminal-handoff";
import { readSessionWorktreeInventory } from "../sessions/worktrees";
import { observeProjectShift } from "../shifts/observations";
import { createProjectShiftRegistry } from "../shifts/registry";
import { readProjectShiftEvidence } from "../shifts/service";
import { canonicalProjectShiftStart } from "../shifts/start-input";
import { readKnowledgeInventory } from "./knowledge-store";
import type { ProjectDeletionStatus } from "./project-lifecycle-protocol";
import { workspaceKey } from "./scope";
import { isProjectId } from "./store";
import { readWorktreeCleanupInventory } from "./worktree-cleanup-store";

type Inventory = Pick<ProjectDeletionStatus, "state" | "reasons">;
const activeTurn = (state: ConversationState) =>
  state.turns.some((turn) =>
    ["accepted", "running", "cancelling", "unknown"].includes(turn.phase),
  );

/** This synchronous read never takes domain leases, repairs records, probes PIDs, or touches repositories. */
export function readProjectLifecycleInventory(
  home: string,
  root: string,
  project: ProjectRecord,
): Inventory {
  if (!project.archived)
    return {
      state: "archive-required",
      reasons: ["Archive the project before deleting its record."],
    };
  return readProjectActivityInventory(home, root, project);
}

/** Complete named ownership read shared by lifecycle and cleanup; archive is a separate policy. */
export function readProjectActivityInventory(
  home: string,
  root: string,
  project: Pick<ProjectRecord, "id">,
  sharedBudget?: () => void,
): Inventory {
  const started = performance.now(),
    reasons: string[] = [],
    unknown: string[] = [];
  let inspected = 0;
  const bounded = () => {
    sharedBudget?.();
    if (++inspected > 4096 || performance.now() - started > 2000)
      throw Error("Inventory exceeded its complete-read budget");
  };
  const source = <T>(label: string, read: () => T): T | undefined => {
    try {
      bounded();
      const value = read();
      bounded();
      return value;
    } catch {
      unknown.push(
        `${label} could not be completely verified. Its saved records have been retained.`,
      );
      return undefined;
    }
  };
  const entries = (
    directory: string,
    accept: (name: string, isDirectory: boolean) => boolean,
  ): string[] => {
    bounded();
    if (readHomeFile(directory).problem !== null)
      throw Error("Unprotected inventory directory");
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Error("Invalid directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const paths: string[] = [];
    const dir = opendirSync(directory);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        bounded();
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
          throw Error("Invalid inventory entry");
        if (accept(entry.name, entry.isDirectory()))
          paths.push(join(directory, entry.name));
      }
    } finally {
      dir.closeSync();
    }
    return paths;
  };
  const identities = source("Session Start identities", () =>
    readRestartIdentityInventory(home, project.id),
  );
  const knowledge = source("Knowledge refresh ownership", () =>
    readKnowledgeInventory(home),
  );
  if (
    knowledge?.some(
      (row) =>
        row.original.projectId === project.id &&
        !["confirmed", "failed"].includes(row.receipt.state),
    )
  )
    reasons.push(
      "A project knowledge generation or publication remains active or unresolved.",
    );
  const sessions = source("Session ownership", () =>
    createSessionRegistry(home).listAll(project.id),
  );
  const forks = source("Codex Fork originals", () =>
    readCodexChatForkInventory(home, project.id),
  );
  const sessionsById = new Map(sessions?.map((row) => [row.id, row])),
    states = new Map<string, ConversationState>();
  const identityByRequest = new Map(
    identities?.map((row) => [row.requestId, row]),
  );
  const linkedChildren = new Set(
    forks
      ?.filter((row) => row.state === "linked")
      .map((row) => row.childAppSessionId),
  );
  const shifts = source("Shift original registry", () =>
    createProjectShiftRegistry({ home, root }).listAll(project.id),
  );
  if (identities?.some((row) => row.state === "attempted"))
    unknown.push(
      "A Session Start dispatch has no confirmed admission or not-sent outcome.",
    );
  if (
    forks?.some((row) => !["reserved", "linked", "retired"].includes(row.state))
  )
    unknown.push("A Codex Fork outcome or child adoption remains unresolved.");
  if (
    identities?.some(
      (row) => row.state === "reserved" || row.state === "attempted",
    )
  )
    reasons.push(
      "A Session Start is reserved or its dispatch remains unresolved.",
    );
  if (forks?.some((row) => row.state !== "linked" && row.state !== "retired"))
    reasons.push(
      "A Codex Fork has not reached a verified linked or not-sent outcome.",
    );
  const inspectConversation = (
    state: ConversationState,
    sessionId?: string,
  ) => {
    if (state.turns.some((turn) => turn.phase === "unknown"))
      unknown.push("A Keeper or session turn has an unknown outcome.");
    if (activeTurn(state))
      reasons.push(
        "A Keeper or session turn is active or has an unknown outcome.",
      );
    const briefs = state.keeperBriefIntents;
    for (const brief of briefs
      ? [...briefs.history, ...(briefs.active ? [briefs.active] : [])]
      : []) {
      bounded();
      if (
        brief.state === "reserved" ||
        (brief.state === "admitted" &&
          !state.turns.some((turn) => turn.requestId === brief.requestId))
      )
        reasons.push(
          "A Keeper brief original is reserved or its admitted turn is missing.",
        );
    }
    if (sessionId) {
      states.set(sessionId, state);
      const session = sessionsById.get(sessionId);
      if (!session)
        unknown.push(
          "A saved session conversation has no verified ownership record.",
        );
      if (session?.provider === "codex" && session.mode === "chat") {
        const facts = state.codexChatOwnerLifecycle ?? [];
        const released = new Set(
          facts
            .filter((fact) => fact.kind === "generation-released")
            .map((fact) => `${fact.requestId}\0${fact.generationId}`),
        );
        if (
          facts.some(
            (fact) =>
              fact.kind === "generation-started" &&
              !released.has(`${fact.requestId}\0${fact.generationId}`),
          )
        )
          unknown.push(
            "A Codex Chat process generation has not confirmed release.",
          );
        if (
          state.frames.some(
            (frame) =>
              frame.event.kind === "coding-chat" &&
              frame.event.event.kind === "process" &&
              !facts.some(
                (fact) =>
                  fact.kind === "generation-started" &&
                  fact.requestId === frame.turnId,
              ),
          )
        )
          unknown.push(
            "Legacy Codex Chat process ownership has no verified release chain.",
          );
        const approvals = new Set<string>();
        for (const frame of state.frames) {
          bounded();
          if (frame.event.kind !== "coding-chat") continue;
          const event = frame.event.event;
          if (event.kind === "approval-request")
            approvals.add(event.approval.id);
          if (event.kind === "approval-resolved")
            approvals.delete(event.approvalId);
        }
        if (approvals.size)
          reasons.push("A native Codex Chat approval remains unresolved.");
      }
    }
  };
  source("Complete conversation journals", () => {
    const paths = entries(join(home, "conversations"), (name, directory) => {
      if (directory) {
        if (name !== "leases") throw Error("Unexpected conversation namespace");
        return false;
      }
      if (
        name.endsWith(".db") ||
        /\.db-(journal|wal|shm)$/.test(name) ||
        /^keeper-project-[a-f0-9-]{36}-proposals\.json$/.test(name)
      )
        return false;
      if (
        !/^(session-[a-f0-9-]{36}|keeper-project-[a-f0-9-]{36})\.json$/.test(
          name,
        )
      )
        throw Error("Unknown conversation entry");
      return true;
    });
    for (const file of paths) {
      bounded();
      const found = readSessionTranscript(home, file);
      if (found.problem !== null || found.text === null)
        throw Error("Missing journal");
      let raw: unknown;
      try {
        raw = JSON.parse(found.text);
      } catch {
        throw Error("Invalid journal");
      }
      if (!raw || typeof raw !== "object" || !("projectId" in raw))
        throw Error("Invalid journal scope");
      const name = file.slice(
          file.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1,
          -5,
        ),
        sessionId = name.startsWith("session-") ? name : undefined;
      const expectedProject = sessionId
        ? sessionsById.has(sessionId)
          ? project.id
          : raw.projectId
        : name.slice("keeper-".length);
      if (!isProjectId(expectedProject)) throw Error("Invalid journal owner");
      const address = sessionId
        ? { kind: "session" as const, projectId: expectedProject, sessionId }
        : undefined;
      if (file !== conversationFile(home, expectedProject, address))
        throw Error("Mismatched conversation address");
      const state = createConversationStore(home, undefined, address).read(
        expectedProject,
      );
      if (expectedProject === project.id) inspectConversation(state, sessionId);
    }
  });
  for (const session of sessions ?? []) {
    bounded();
    const identity = identityByRequest.get(session.requestId),
      state = states.get(session.id);
    if (
      identity &&
      (identity.requestHash !== session.requestHash ||
        identity.provider !== session.provider ||
        identity.mode !== session.mode)
    )
      unknown.push("A retained Session Start and its session owner disagree.");
    const notSent =
      identity &&
      (identity.state === "not-sent" || identity.state === "retired");
    if (!state?.turns.length && !linkedChildren.has(session.id) && !notSent)
      unknown.push(
        "A retained session owner has no verified settled turn or not-sent identity.",
      );
    if (
      notSent &&
      state?.turns.some((turn) => turn.requestId === session.requestId)
    )
      unknown.push(
        "A not-sent Session Start conflicts with an accepted private turn.",
      );
  }
  if (
    identities?.some(
      (row) =>
        row.state === "admitted" &&
        !sessions?.some((session) => session.requestId === row.requestId),
    )
  )
    unknown.push(
      "An admitted Session Start is missing its owned session journal.",
    );
  if (
    forks?.some(
      (row) =>
        row.state === "linked" && !sessionsById.has(row.childAppSessionId),
    )
  )
    unknown.push("A linked Fork is missing its child ownership record.");
  source("Keeper proposal originals", () => {
    const journal = createKeeperProposalStore(home).inventory(project.id);
    if (journal.records.some((row) => row.phase === "unknown"))
      unknown.push("A Keeper approval outcome is unknown.");
    if (
      journal.records.some(
        (row) =>
          row.pending || row.phase === "approved" || row.phase === "unknown",
      )
    )
      reasons.push("A Keeper approval is in flight or its outcome is unknown.");
    if (journal.version !== 1)
      for (const intent of journal.sessionStarts) {
        bounded();
        if (
          !sessions?.some(
            (session) =>
              session.requestId === intent.original.start.requestId &&
              session.requestHash === intent.startHash &&
              workspaceKey(session.workspace) ===
                workspaceKey(intent.workspace),
          )
        )
          unknown.push(
            "A Keeper session approval has no confirmed downstream Start owner.",
          );
      }
    if (journal.version === 3)
      for (const intent of journal.shiftStarts) {
        bounded();
        if (
          !shifts?.some(
            (shift) =>
              shift.requestHash === intent.startHash &&
              workspaceKey(shift.workspace) ===
                workspaceKey(intent.workspace) &&
              canonicalProjectShiftStart(
                project.id,
                intent.workspace,
                shift.request,
              ) ===
                canonicalProjectShiftStart(
                  project.id,
                  intent.workspace,
                  intent.original.start,
                ),
          )
        )
          unknown.push(
            "A Keeper Shift approval has no verified downstream original.",
          );
      }
  });
  source("Shift originals and terminal evidence", () => {
    for (const intent of shifts ?? []) {
      bounded();
      const observed = observeProjectShift(
        intent,
        readProjectShiftEvidence(home, intent, false),
      );
      if (observed.phase === "unknown" || observed.phase === "needs-recovery")
        unknown.push(
          "A project Shift has no verified settled terminal receipt.",
        );
      if (
        observed.phase !== "stopped" ||
        (observed.actual !== null && observed.actual.running !== 0)
      )
        reasons.push(
          "A project Shift is active or has no verified settled Stop receipt.",
        );
    }
  });
  source("Council originals", () => {
    const files = entries(join(home, "council-reviews"), (name, directory) => {
      if (
        directory ||
        !/^[a-f0-9]{64}\.(json|lock\.db)(-(journal|wal|shm))?$/.test(name)
      )
        throw Error("Unknown Council entry");
      return name.endsWith(".json");
    });
    if (
      readProjectCouncilInventory(home, files, project.id).some((row) =>
        ["reserved", "dispatch-claimed", "running"].includes(row.state),
      )
    )
      reasons.push("A Council original is reserved or still owns a review.");
  });
  source("Checkpoint review originals", () => {
    const files = entries(
      join(home, "checkpoint-reviews"),
      (name, directory) => {
        if (
          directory ||
          !/^[a-f0-9]{64}\.(json|lock\.db)(-(journal|wal|shm))?$/.test(name)
        )
          throw Error("Unknown checkpoint review entry");
        return name.endsWith(".json");
      },
    );
    if (
      readProjectCheckpointReviewInventory(home, files, project.id).some(
        (row) => ["prepared", "dispatching", "unknown"].includes(row.state),
      )
    )
      reasons.push(
        "A checkpoint review is prepared, dispatching, or has an unknown outcome.",
      );
  });
  source("Native terminal handoffs", () => {
    const dirs = entries(
      join(home, "session-terminal-handoffs"),
      (name, directory) => {
        if (!directory || !/^[a-f0-9]{32}$/.test(name))
          throw Error("Unknown terminal namespace");
        return true;
      },
    );
    if (
      readTerminalHandoffInventory(home, dirs).some(
        (row) =>
          row.projectId === project.id &&
          !["closed", "refused"].includes(row.phase),
      )
    )
      reasons.push(
        "A native terminal handoff is open or its outcome is unknown.",
      );
  });
  source("Worktree cleanup originals", () => {
    for (const row of readWorktreeCleanupInventory(home)) {
      if (row.original.projectId !== project.id) continue;
      if (row.phase === "unknown")
        unknown.push("A worktree cleanup outcome is unknown.");
      else if (row.phase === "reserved" || row.phase === "attempted")
        reasons.push("A worktree cleanup original remains unresolved.");
    }
  });
  source("Worktree creation receipts", () => {
    if (
      readSessionWorktreeInventory(home).some(
        (row) =>
          row.plan.projectId === project.id &&
          (row.receipt === null || row.receipt.state === "unknown"),
      )
    )
      unknown.push("A worktree creation request has an unknown outcome.");
  });
  return {
    state: unknown.length ? "unknown" : reasons.length ? "active" : "eligible",
    reasons: [...new Set([...unknown, ...reasons])].slice(0, 20),
  };
}

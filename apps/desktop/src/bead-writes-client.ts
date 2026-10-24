import { z } from "zod";
import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { workspaceKey } from "../../../scripts/projects/scope";
import { QUEUE_TABLE } from "../../../scripts/scheduler/queue-table";
import { QUEUE_STATES } from "../../../types/hearth";

export interface BeadWriteScope {
  projectId: string;
  workspace: string;
}
export interface DesktopBeadCreate {
  title: string;
  type?: string;
  priority?: string;
  parent: string;
  description?: string;
  acceptance?: string;
  labels?: string[];
  complexity?: string;
  fileMap?: string[];
}
export type DesktopBeadAction =
  | "create"
  | "claim"
  | "comment"
  | "close"
  | "propose"
  | "approve"
  | "queue"
  | "pause"
  | "resume"
  | "reassign";
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const noticeSchema = z
  .object({
    key: id,
    projectId: z.string().min(1).max(100),
    workspace: z.string().min(1).max(1024),
    action: z.enum([
      "create",
      "claim",
      "comment",
      "close",
      "propose",
      "approve",
      "queue",
      "pause",
      "resume",
      "reassign",
    ]),
    beadId: id.nullable(),
    title: z.string().max(200).nullable(),
    createdId: id.nullable(),
    targetSmith: z.string().min(1).max(200).optional(),
    queueTo: z.enum(QUEUE_STATES).optional(),
    stage: z.enum(["write", "propose"]),
    phase: z.enum(["sending", "done", "refused", "unknown"]),
    message: z.string().max(1000),
  })
  .strict();
export type BeadWriteNotice = z.infer<typeof noticeSchema>;
const savedSchema = z
  .object({ version: z.literal(1), entries: z.array(noticeSchema).max(20) })
  .strict();
const recordFields = {
  id,
  recorded: z.boolean(),
  recordError: z.string().max(1000).optional(),
};
const writeResult = z
  .object({
    ...recordFields,
    action: z.enum(["create", "claim", "comment", "close"]),
    status: z.string().max(80).optional(),
    assignee: z.string().max(200).optional(),
    labels: z.array(z.string().max(200)).max(200).optional(),
    comment: z
      .object({
        id: z.string().min(1).max(200),
        author: z.string().max(200),
        createdAt: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    updatedAt: z.string().max(100).optional(),
  })
  .strict();
const moveResult = z
  .object({
    ...recordFields,
    action: z.enum(["propose", "approve", "queue", "pause", "resume"]),
    from: z.enum(QUEUE_STATES).nullable(),
    to: z.enum(QUEUE_STATES),
  })
  .strict()
  .refine((receipt) =>
    QUEUE_TABLE.some(
      (rule) =>
        rule.action === receipt.action &&
        rule.from === receipt.from &&
        rule.to === receipt.to &&
        rule.by.includes("operator"),
    ),
  );
const reassignResult = z
  .object({
    ...recordFields,
    state: z.enum(QUEUE_STATES),
    smith: z.string().min(1).max(200),
  })
  .strict();
const KEY = "agent-forge.desktop-bead-writes.v1";
const check =
  "Outcome unknown: check the bead before doing anything else. This write will not be repeated automatically.";
const same = (a: BeadWriteScope, b: BeadWriteScope) =>
  a.projectId === b.projectId &&
  workspaceKey(a.workspace) === workspaceKey(b.workspace);
interface Dependencies {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  requestId(): string;
  canWrite(): boolean;
  post(
    scope: BeadWriteScope,
    action: DesktopBeadAction,
    beadId: string | null,
    body: unknown,
  ): Promise<ActionOutcome>;
  changed(scope: BeadWriteScope, beadId: string | null): void;
  /** Origin-wide exclusive ownership, including the bounded network request. */
  withJournalLock<T>(work: () => Promise<T>): Promise<T>;
}

/** Retains only pending operation metadata. No request body is stored or automatically retried. */
export function createDesktopBeadWrites(deps: Dependencies) {
  let entries: BeadWriteNotice[] = [],
    problem = "",
    blocked = false;
  const listeners = new Set<() => void>();
  const inflight = new Set<string>();
  const scopeKey = (scope: BeadWriteScope) =>
    JSON.stringify([scope.projectId, workspaceKey(scope.workspace)]);
  const tell = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A view cannot change a write outcome. */
      }
    }
  };
  const hydrate = () => {
    try {
      if (!deps.storage) throw Error("Unavailable storage");
      const text = deps.storage.getItem(KEY);
      if (text) {
        if (text.length > 100_000) throw Error("Oversized history");
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw Error("Unreadable history");
        }
        const saved = savedSchema.safeParse(raw);
        if (
          !saved.success ||
          new Set(saved.data.entries.map((item) => item.key)).size !==
            saved.data.entries.length
        )
          throw Error("Unverified history");
        entries = [
          ...entries.filter((item) => item.phase === "done"),
          ...saved.data.entries.map(
            (item): BeadWriteNotice =>
              item.phase === "sending"
                ? {
                    ...item,
                    phase: "unknown",
                    message: item.createdId
                      ? `Created ${item.createdId}. Its Proposed transition is unconfirmed. ${check}`
                      : check,
                  }
                : item,
          ),
        ];
      } else entries = entries.filter((item) => item.phase === "done");
    } catch {
      blocked = true;
      problem =
        "The saved write history could not be read. It has been kept; no new write will be sent.";
    }
  };
  hydrate();
  const save = () => {
    try {
      if (!deps.storage) throw Error("Unavailable storage");
      const pending = entries.filter((item) => item.phase !== "done");
      const text = JSON.stringify(
        savedSchema.parse({ version: 1, entries: pending }),
      );
      if (text.length > 100_000) throw Error("Oversized history");
      deps.storage.setItem(KEY, text);
      return true;
    } catch {
      blocked = true;
      problem =
        "This window could not keep the write result across a reload. Check the bead before sending another write.";
      return false;
    }
  };
  const held = (scope: BeadWriteScope) =>
    blocked ||
    inflight.has(scopeKey(scope)) ||
    entries.some(
      (item) =>
        same(item, scope) && ["sending", "unknown"].includes(item.phase),
    );
  const finish = (
    notice: BeadWriteNotice,
    phase: BeadWriteNotice["phase"],
    message: string,
  ) => {
    notice.phase = phase;
    notice.message = message.slice(0, 1000);
    save();
    tell();
  };
  const invoke = async (
    notice: BeadWriteNotice,
    action: DesktopBeadAction,
    beadId: string | null,
    body: unknown,
  ) => {
    let answer: ActionOutcome;
    try {
      answer = await deps.post(
        { projectId: notice.projectId, workspace: notice.workspace },
        action,
        beadId,
        body,
      );
    } catch {
      answer = { state: "unknown", message: check };
    }
    if (answer.state !== "done") {
      finish(
        notice,
        answer.state,
        `${notice.createdId ? `Created ${notice.createdId}. Proposed: ` : ""}${answer.message}`,
      );
      return null;
    }
    const parsed =
      action === "reassign"
        ? reassignResult.safeParse(answer.data)
        : ["propose", "approve", "queue", "pause", "resume"].includes(action)
          ? moveResult.safeParse(answer.data)
          : writeResult.safeParse(answer.data);
    if (
      !parsed.success ||
      (action === "reassign"
        ? !("smith" in parsed.data) ||
          !body ||
          typeof body !== "object" ||
          !("smith" in body) ||
          parsed.data.smith !== body.smith
        : !("action" in parsed.data) || parsed.data.action !== action) ||
      (beadId !== null && parsed.data.id !== beadId) ||
      (action === "create" &&
        (!("status" in parsed.data) || parsed.data.status !== "open")) ||
      (action === "claim" &&
        (!("status" in parsed.data) ||
          parsed.data.status !== "in_progress" ||
          !("assignee" in parsed.data) ||
          !parsed.data.assignee?.trim())) ||
      (action === "close" &&
        (!("status" in parsed.data) || parsed.data.status !== "closed")) ||
      (action === "comment" &&
        (!("comment" in parsed.data) || !parsed.data.comment))
    ) {
      finish(
        notice,
        "unknown",
        `${notice.createdId ? `Created ${notice.createdId}. ` : ""}The returned bead and action could not be verified. ${check}`,
      );
      return null;
    }
    return parsed.data;
  };
  const sendLocked = async (
    scope: BeadWriteScope,
    action: DesktopBeadAction,
    beadId: string | null,
    body: unknown,
    initial: "open" | "proposed" = "open",
  ): Promise<BeadWriteNotice | null> => {
    if (
      blocked ||
      entries.some(
        (item) =>
          same(item, scope) && ["sending", "unknown"].includes(item.phase),
      ) ||
      !deps.canWrite()
    )
      return null;
    if (entries.filter((item) => item.phase !== "done").length >= 20) {
      problem =
        "Twenty writes still need checking. Check and dismiss them before sending another write.";
      tell();
      return null;
    }
    problem = "";
    const copied = structuredClone(body);
    const notice = noticeSchema.parse({
      ...scope,
      key: deps.requestId(),
      action,
      beadId,
      title:
        action === "create" &&
        copied &&
        typeof copied === "object" &&
        "title" in copied
          ? copied.title
          : null,
      createdId: null,
      ...(action === "reassign" &&
      copied &&
      typeof copied === "object" &&
      "smith" in copied
        ? { targetSmith: copied.smith }
        : {}),
      stage: "write",
      phase: "sending",
      message: "Sending…",
    });
    if (entries.some((item) => item.key === notice.key)) return null;
    entries = [
      ...entries.filter((item) => item.phase !== "done" || !same(item, scope)),
      notice,
    ];
    if (!save()) {
      notice.phase = "refused";
      notice.message =
        "The write could not be retained before sending. Nothing was sent.";
      tell();
      return notice;
    }
    tell();
    const result = await invoke(notice, action, beadId, copied);
    if (!result) return notice;
    if ("to" in result) notice.queueTo = result.to;
    if (action === "create") notice.createdId = result.id;
    const changed = () => {
      // A projection refresh cannot erase a confirmed external write.
      try {
        deps.changed(scope, result.id);
      } catch {
        /* The result remains inspectable. */
      }
    };
    changed();
    if (action === "create" && initial === "proposed") {
      if (!deps.canWrite()) {
        finish(
          notice,
          "refused",
          `Created ${result.id}. Proposed was not sent because writes are unavailable. Open the bead to check it; do not create it again.`,
        );
        return notice;
      }
      notice.stage = "propose";
      notice.message = `Created ${result.id}. Sending Proposed transition…`;
      if (!save()) {
        notice.phase = "unknown";
        notice.message = `Created ${result.id}. The Proposed transition was not sent because its result could not be retained. Check the bead; do not create it again.`;
        tell();
        return notice;
      }
      tell();
      const proposed = await invoke(notice, "propose", result.id, {});
      if (!proposed) return notice;
      changed();
      finish(
        notice,
        "done",
        `Done. Created ${result.id} as Proposed.${!result.recorded || !proposed.recorded ? " Its Activity record could not be stored." : ""}`,
      );
    } else
      finish(
        notice,
        "done",
        `Done.${action === "create" ? ` Created ${result.id}.` : ""}${!result.recorded ? " Its Activity record could not be stored." : ""}`,
      );
    return notice;
  };
  const send = async (
    scope: BeadWriteScope,
    action: DesktopBeadAction,
    beadId: string | null,
    body: unknown,
    initial: "open" | "proposed" = "open",
  ) => {
    if (held(scope) || !deps.canWrite()) return null;
    scope = { ...scope };
    try {
      body = structuredClone(body);
    } catch {
      problem =
        "The reviewed write could not be retained before sending. Nothing was sent.";
      tell();
      return null;
    }
    const key = scopeKey(scope);
    inflight.add(key);
    tell();
    let entered = false;
    try {
      return await deps.withJournalLock(async () => {
        entered = true;
        hydrate();
        return sendLocked(scope, action, beadId, body, initial);
      });
    } catch {
      problem = entered
        ? check
        : "The shared write history is busy or unavailable. Nothing was sent from this request. Check the retained writes before trying again.";
      const pending = entries.find(
        (item) => same(item, scope) && item.phase === "sending",
      );
      if (pending) {
        pending.phase = "unknown";
        pending.message = check;
      }
      return null;
    } finally {
      inflight.delete(key);
      tell();
    }
  };
  return {
    held,
    problem: () => problem,
    notices: () => entries.filter((item) => item.phase !== "done"),
    latest: (scope: BeadWriteScope) =>
      entries.filter((item) => same(item, scope)).at(-1) ?? null,
    create: (
      scope: BeadWriteScope,
      fields: DesktopBeadCreate,
      initial: "open" | "proposed",
    ) => send(scope, "create", null, fields, initial),
    act: (
      scope: BeadWriteScope,
      action: Exclude<DesktopBeadAction, "create">,
      beadId: string,
      text?: string,
    ) =>
      send(
        scope,
        action,
        beadId,
        action === "comment"
          ? { text }
          : action === "close"
            ? { reason: text }
            : action === "reassign"
              ? { smith: text }
              : {},
      ),
    async checked(key: string) {
      const notice = entries.find((item) => item.key === key);
      if (!notice || notice.phase === "sending") return false;
      try {
        return await deps.withJournalLock(async () => {
          hydrate();
          if (blocked) return false;
          const old = entries;
          entries = entries.filter((item) => item.key !== key);
          if (!save()) {
            entries = old;
            tell();
            return false;
          }
          tell();
          problem = "";
          return true;
        });
      } catch {
        problem =
          "The shared write history is busy. The retained write was not dismissed.";
        tell();
        return false;
      }
    },
    refresh() {
      if (inflight.size === 0) {
        hydrate();
        tell();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

import { workspaceKey } from "../../../scripts/projects/scope";
import {
  projectShiftOptionsSchema,
  projectShiftReceiptSchema,
  projectShiftStartSchema,
  projectShiftsPageSchema,
} from "../../../scripts/shifts/protocol";
import type {
  ProjectShiftOptions,
  ProjectShiftReceipt,
  ProjectShiftStartRequest,
  ProjectShiftsPage,
} from "../../../types/project-shifts";
import {
  type ProjectShiftIdentities,
  type ProjectShiftIdentity,
  type ProjectShiftScope,
  projectShiftInputHash,
} from "./project-shift-identities";

export interface ProjectShiftView {
  page: ProjectShiftsPage | null;
  options: ProjectShiftOptions | null;
  original: ProjectShiftReceipt | null;
  identity: ProjectShiftIdentity | null;
  identityError: string | null;
  pendingStart: ProjectShiftStartRequest | null;
  pendingControl: { requestId: string; kind: "stop" | "recover" } | null;
  loading: boolean;
  optionsLoading: boolean;
  busy: boolean;
  error: string | null;
  optionsError: string | null;
  notice: string;
}
const ORIGINAL_UNKNOWN =
  "The original shift outcome could not be verified. Check that original request; no Start was sent again and a replacement remains held.";
const base = (scope: ProjectShiftScope) =>
  `/projects/${encodeURIComponent(scope.projectId)}/shifts`;

/** App-root owner of explicit actions. Observers and recreation only read; no retry dispatch exists. */
export function createProjectShiftsClient(deps: {
  identities: ProjectShiftIdentities;
  canWrite(): boolean;
  read(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<Response>;
  mint(): string;
  changed(): void;
  now?: () => number;
}) {
  const views = new Map<string, ProjectShiftView>(),
    reads = new Map<string, Promise<void>>(),
    revisions = new Map<ProjectShiftView, number>();
  const revision = (current: ProjectShiftView) => revisions.get(current) ?? 0;
  const advance = (current: ProjectShiftView) =>
    revisions.set(current, revision(current) + 1);
  const now = deps.now ?? Date.now;
  const view = (scope: ProjectShiftScope): ProjectShiftView => {
    const key = `${scope.projectId}/${workspaceKey(scope.workspace)}`;
    let found = views.get(key);
    if (!found) {
      found = {
        page: null,
        options: null,
        original: null,
        identity: null,
        identityError: null,
        pendingStart: null,
        pendingControl: null,
        loading: false,
        optionsLoading: false,
        busy: false,
        error: null,
        optionsError: null,
        notice: "",
      };
      views.set(key, found);
    }
    return found;
  };
  const changed = () => deps.changed();
  const verify = async (
    scope: ProjectShiftScope,
    raw: unknown,
    expected?: { requestId: string; requestHash: string; shiftId?: string },
  ): Promise<ProjectShiftReceipt> => {
    const checked = projectShiftReceiptSchema.safeParse(raw);
    if (
      !checked.success ||
      checked.data.intent.projectId !== scope.projectId ||
      workspaceKey(checked.data.intent.workspace) !==
        workspaceKey(scope.workspace)
    )
      throw Error("Foreign or invalid original");
    const receipt = checked.data;
    if (
      receipt.intent.requestHash !==
        (await projectShiftInputHash(scope, receipt.intent.request)) ||
      (expected &&
        (receipt.intent.request.requestId !== expected.requestId ||
          receipt.intent.requestHash !== expected.requestHash ||
          (expected.shiftId !== undefined &&
            receipt.intent.shiftId !== expected.shiftId)))
    )
      throw Error("Changed original input");
    return receipt;
  };
  const identity = async (scope: ProjectShiftScope) => {
    const current = view(scope);
    try {
      current.identity = await deps.identities.read(scope);
      current.identityError = null;
    } catch {
      current.identityError =
        "Saved original shift identities are unavailable. No new Start can be sent; their saved bytes have been kept.";
    }
    return current.identity;
  };
  const adopt = async (
    scope: ProjectShiftScope,
    receipt: ProjectShiftReceipt,
    expectedRevision?: number,
  ) => {
    const current = view(scope),
      held = await identity(scope);
    if (
      expectedRevision !== undefined &&
      revision(current) !== expectedRevision
    )
      return false;
    if (
      held?.requestId === receipt.intent.request.requestId &&
      held.requestHash !== receipt.intent.requestHash
    )
      throw Error("Conflicting original identity");
    const items = current.page?.items ?? [];
    const previous = items.find(
      (row) =>
        row.intent.request.requestId === receipt.intent.request.requestId,
    );
    if (
      previous?.observation.phase === "stopped" &&
      receipt.observation.phase !== "stopped"
    )
      return false;
    advance(current);
    current.page = {
      projectId: scope.projectId,
      asOf: new Date(now()).toISOString(),
      items: previous
        ? items.map((row) =>
            row.intent.request.requestId === receipt.intent.request.requestId
              ? receipt
              : row,
          )
        : [...items, receipt],
    };
    if (held?.requestId === receipt.intent.request.requestId) {
      current.original = receipt;
      current.pendingStart = null;
      if (receipt.observation.phase === "stopped") {
        await deps.identities.release(held);
        current.identity = await deps.identities.read(scope);
      }
    } else if (!held) current.original = receipt;
    current.notice =
      receipt.observation.phase === "stopped"
        ? "Shift stopped. Its verified original and private attempt history remain available."
        : receipt.observation.phase === "stopping"
          ? "Stop requested. Waiting for supervised attempts to exit and owned work to settle."
          : receipt.observation.phase === "needs-recovery"
            ? "The original shift needs explicit recovery. It will not be launched again."
            : (receipt.observation.reason ??
              "The actual original shift is observed. Starting and provider completion are separate states.");
    return true;
  };
  const readOriginal = async (scope: ProjectShiftScope, requestId?: string) => {
    const current = view(scope),
      held = await identity(scope),
      id = requestId ?? held?.requestId;
    if (!id) return;
    const expectedRevision = revision(current);
    const known = current.page?.items.find(
        (row) => row.intent.request.requestId === id,
      ),
      expected =
        held?.requestId === id
          ? held
          : known
            ? {
                requestId: id,
                requestHash: known.intent.requestHash,
                shiftId: known.intent.shiftId,
              }
            : undefined;
    const receipt = await verify(
      scope,
      await deps.read(`${base(scope)}/requests/${encodeURIComponent(id)}`),
      expected,
    );
    if (receipt.intent.request.requestId !== id)
      throw Error("Wrong original request");
    const adopted = await adopt(scope, receipt, expectedRevision);
    if (adopted && current.pendingControl?.requestId === id)
      current.pendingControl = null;
  };
  const response = async (reply: Response) => {
    let value: unknown;
    try {
      value = await reply.json();
    } catch {
      throw Error("Invalid action reply");
    }
    if (
      !reply.ok ||
      !value ||
      typeof value !== "object" ||
      !("ok" in value) ||
      value.ok !== true ||
      !("data" in value)
    )
      throw Error("Unknown action outcome");
    return value.data;
  };
  return {
    get: view,
    async loadOptions(scope: ProjectShiftScope) {
      const current = view(scope);
      if (current.optionsLoading) return;
      current.optionsLoading = true;
      changed();
      try {
        const checked = projectShiftOptionsSchema.safeParse(
          await deps.read(`${base(scope)}/options`),
        );
        if (
          !checked.success ||
          checked.data.projectId !== scope.projectId ||
          workspaceKey(checked.data.workspace) !== workspaceKey(scope.workspace)
        )
          throw Error("Invalid options scope");
        current.options = checked.data;
        current.optionsError = null;
      } catch {
        current.optionsError =
          "Current shift defaults and scope could not be verified. Existing original reads and cleanup controls remain available.";
      } finally {
        current.optionsLoading = false;
        changed();
      }
    },
    refresh(scope: ProjectShiftScope): Promise<void> {
      const key = `${scope.projectId}/${workspaceKey(scope.workspace)}`,
        pending = reads.get(key);
      if (pending) return pending;
      const current = view(scope);
      const expectedRevision = revision(current);
      current.loading = true;
      changed();
      const work = (async () => {
        try {
          const checked = projectShiftsPageSchema.safeParse(
            await deps.read(base(scope)),
          );
          if (!checked.success || checked.data.projectId !== scope.projectId)
            throw Error("Foreign page");
          const items = await Promise.all(
            checked.data.items.map((row) => verify(scope, row)),
          );
          const held = await identity(scope);
          if (revision(current) !== expectedRevision) return;
          current.page = { ...checked.data, items };
          current.error = null;
          if (held)
            await readOriginal(scope, held.requestId).catch(() => {
              current.notice = ORIGINAL_UNKNOWN;
            });
        } catch {
          current.error =
            "The scoped shift read could not be verified. Saved originals and the last verified observations have been kept.";
        } finally {
          current.loading = false;
          changed();
          reads.delete(key);
        }
      })();
      reads.set(key, work);
      return work;
    },
    async check(scope: ProjectShiftScope, requestId?: string) {
      const current = view(scope);
      if (current.loading) return;
      current.loading = true;
      changed();
      try {
        await readOriginal(scope, requestId);
      } catch {
        current.notice = ORIGINAL_UNKNOWN;
      } finally {
        current.loading = false;
        changed();
      }
    },
    async start(
      scope: ProjectShiftScope,
      input: Omit<ProjectShiftStartRequest, "requestId">,
    ) {
      const current = view(scope);
      if (current.busy) return;
      const heldRequest =
        current.identity?.requestId ??
        current.pendingStart?.requestId ??
        (current.original && current.original.observation.phase !== "stopped"
          ? current.original.intent.request.requestId
          : undefined);
      if (heldRequest) {
        try {
          await readOriginal(scope, heldRequest);
        } catch {
          current.notice = ORIGINAL_UNKNOWN;
        }
        changed();
        return;
      }
      const choices = current.options;
      if (
        !deps.canWrite() ||
        current.identityError ||
        !choices ||
        current.optionsError ||
        current.optionsLoading ||
        !choices.availability.start ||
        !Number.isFinite(Date.parse(choices.asOf)) ||
        now() - Date.parse(choices.asOf) > 30_000 ||
        input.expectedCatalogRevision !== choices.catalogRevision ||
        (input.options.epic !== undefined &&
          !choices.epics.some((row) => row.id === input.options.epic)) ||
        (input.options.smith !== undefined &&
          !choices.smiths.names.includes(input.options.smith))
      ) {
        current.notice =
          "Review the current project shift defaults and bounds before Start.";
        changed();
        return;
      }
      current.busy = true;
      advance(current);
      changed();
      let attempted = false;
      try {
        const saved = await deps.identities.reserve(
          scope,
          structuredClone(input),
          deps.mint,
        );
        current.identity = saved.identity;
        current.identityError = null;
        if (!saved.created || !saved.request) {
          await readOriginal(scope, saved.identity.requestId);
          return;
        }
        current.pendingStart = saved.request;
        if (!deps.canWrite()) throw Error("Connection changed before POST");
        const checked = projectShiftStartSchema.safeParse(saved.request);
        if (!checked.success) throw Error("Invalid reviewed bounds");
        attempted = true;
        const receipt = await verify(
          scope,
          await response(
            await deps.post(
              `/__agent-forge${base(scope)}`,
              structuredClone(checked.data),
            ),
          ),
          saved.identity,
        );
        await adopt(scope, receipt);
      } catch {
        await identity(scope);
        current.notice =
          attempted || current.identity
            ? ORIGINAL_UNKNOWN
            : "Original identity storage or reviewed bounds could not be verified. This Start was not sent; saved identities were kept.";
      } finally {
        current.busy = false;
        changed();
      }
    },
    async control(
      scope: ProjectShiftScope,
      requestId: string,
      kind: "stop" | "recover",
    ) {
      const current = view(scope),
        target = current.page?.items.find(
          (row) => row.intent.request.requestId === requestId,
        );
      if (
        !deps.canWrite() ||
        current.busy ||
        current.pendingControl ||
        !target ||
        !(kind === "stop"
          ? ["starting", "running", "throttled"].includes(
              target.observation.phase,
            )
          : target.observation.phase === "needs-recovery")
      )
        return;
      current.busy = true;
      current.pendingControl = { requestId, kind };
      advance(current);
      changed();
      try {
        const receipt = await verify(
          scope,
          await response(
            await deps.post(
              `/__agent-forge${base(scope)}/${encodeURIComponent(target.intent.shiftId)}/${kind}`,
              {},
            ),
          ),
          {
            requestId,
            requestHash: target.intent.requestHash,
            shiftId: target.intent.shiftId,
          },
        );
        await adopt(scope, receipt);
        current.pendingControl = null;
      } catch {
        current.notice = `The original shift ${kind} outcome could not be verified. Check the original request before another action.`;
      } finally {
        current.busy = false;
        changed();
      }
    },
  };
}
export type ProjectShiftsClient = ReturnType<typeof createProjectShiftsClient>;

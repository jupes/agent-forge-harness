import { z } from "zod";
import { servedStatically } from "../../../docs/js/hearth-read";
import {
  createOperatorClient,
  launchSettled,
  type OperatorClientOptions,
  type OperatorRead,
} from "../../../docs/js/operator";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { projectWorkbenchPageSchema } from "../../../scripts/projects/workbench-protocol";
import { providerReadinessPageSchema } from "../../../scripts/providers/protocol";
import { parseBeadsIssueId } from "../../../scripts/run-correlation";
import { ownedCodingSessionSchema } from "../../../scripts/sessions/codex-owned-wire-protocol";
import { projectShiftsPageSchema } from "../../../scripts/shifts/protocol";
import { inboxUsageRulesDocumentSchema } from "../../../types/inbox-usage";
import {
  projectCouncilHistorySchema,
  projectCouncilOriginalReadSchema,
} from "../../../types/project-council";
import { projectCouncilRunReadSchema } from "../../../types/project-council-run-read";
import type { ProjectsHome } from "../../../types/project-summary";
import {
  CODEX_CHAT_DECISION_IDENTITIES,
  createCodexChatDecisionIdentities,
} from "./codex-chat-decision-identities";
import {
  createGeminiChatDecisionIdentities,
  GEMINI_CHAT_DECISION_IDENTITIES,
} from "./gemini-chat-decision-identities";
import {
  type InboxBeadShiftFact,
  projectInboxBeadShiftSources,
} from "./inbox-bead-shift-source";
import {
  createInboxCheckpointClient,
  createInboxCheckpointReads,
  type InboxCheckpointReads,
} from "./inbox-checkpoint-client";
import type { InboxRetainedCheckpointFact } from "./inbox-checkpoint-retained-source";
import type { InboxCheckpointFact } from "./inbox-checkpoint-source";
import { withInboxReadSlot } from "./inbox-client";
import {
  type InboxCouncilFact,
  projectInboxCouncilSource,
} from "./inbox-council-source";
import {
  type InboxGateFact,
  projectInboxGateSource,
} from "./inbox-gate-source";
import {
  type InboxUsageFact,
  projectInboxUsageSource,
} from "./inbox-usage-source";
import {
  bindInboxCardIdentity,
  type InboxCard,
  type InboxCoverage,
} from "./inbox-view";
import { type DesktopRoute, desktopHref } from "./navigation";
import { verifyProjectCouncilOriginalRead } from "./project-council-proof";
import type { SessionProjectView } from "./session-client";
import type { UsageThresholdReportsInput } from "./usage-threshold-report-discovery";

/** Own the SDK's physical children even when its result deadline wins first. */
export function createInboxOperatorRead(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: Pick<
    OperatorClientOptions,
    "staticCopy" | "ready" | "sessionKeys" | "timers"
  > = {},
): OperatorRead {
  return async (url, init, limits) => {
    if ((init?.method && init.method !== "GET") || init?.body != null)
      throw Error("Inbox source transport only permits reads.");
    const children: Promise<void>[] = [];
    const client = createOperatorClient(
      async (path, request) => {
        let finish!: () => void;
        children.push(
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        );
        let response: Response;
        try {
          response = await fetchImpl(path, request);
        } catch (error) {
          finish();
          throw error;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          finish();
          return response;
        }
        let cancellation: Promise<void> | null = null;
        const done = () => {
          reader.releaseLock();
          finish();
        };
        const cancel = () =>
          (cancellation ??= Promise.resolve()
            .then(() => reader.cancel())
            .then(done, done));
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(output) {
              try {
                const part = await reader.read();
                if (part.done) {
                  if (!cancellation) done();
                  output.close();
                } else output.enqueue(part.value);
              } catch (error) {
                output.error(error);
                await cancel();
              }
            },
            cancel,
          }),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      },
      { staticCopy: servedStatically(), ready: launchSettled, ...options },
    );
    try {
      return await client.read(url, init, limits);
    } finally {
      await Promise.allSettled(children);
    }
  };
}
export const inboxOperatorRead = createInboxOperatorRead((url, init) =>
  fetch(url, init),
);
/** The caller pools this complete task; do not add an outer result-deadline race. */
export const readInboxSourceJson = (path: string) =>
  readReply(
    inboxOperatorRead,
    path.startsWith("/__agent-forge/") ? path : "/__agent-forge" + path,
    new AbortController().signal,
  );

const kinds = [
  "bead-approval",
  "halted-bead",
  "stopped-shift",
  "failed-gate",
  "checkpoint-review",
  "council-verdict",
  "usage-threshold",
] as const;
type Kind = (typeof kinds)[number];
type Fact =
  | InboxBeadShiftFact
  | InboxGateFact
  | InboxCheckpointFact
  | InboxRetainedCheckpointFact
  | InboxCouncilFact
  | InboxUsageFact;
const unavailable = "The complete current Inbox source could not be verified.";
const maxReply = 4 * 1024 * 1024;
const envelope = z
  .object({ ok: z.boolean(), data: z.unknown(), error: z.string().nullable() })
  .strict();
const good = {
  started: true,
  settled: true,
  complete: true,
  fresh: true,
  error: null,
} as const;
const source = <T>(raw: T) => ({ raw, lastVerified: null, coverage: good });
const key = (scope: { projectId: string; workspace: string }) =>
  JSON.stringify([scope.projectId, workspaceKey(scope.workspace)]);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One complete body, including cancellation settlement. Caller owns admission. */
async function readReply(
  reader: OperatorRead,
  path: string,
  signal: AbortSignal,
  charged: (bytes: number) => void = () => {},
) {
  if (signal.aborted) throw Error(unavailable);
  const response = await reader(
    path,
    { method: "GET", signal },
    { maxBodyBytes: maxReply },
  );
  const body = response.body?.getReader();
  if (!body) throw Error(unavailable);
  let cancellation: Promise<void> | null = null;
  const cancel = () =>
    (cancellation ??= Promise.resolve()
      .then(() => body.cancel())
      .then(
        () => {},
        () => {},
      ));
  const abort = () => {
    void cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    if (signal.aborted) throw Error(unavailable);
    for (;;) {
      const part = await body.read();
      if (signal.aborted) throw Error(unavailable);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxReply) throw Error(unavailable);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(unavailable);
    }
    const parsed = envelope.parse(raw);
    if (!response.ok || !parsed.ok || parsed.error !== null)
      throw Error(unavailable);
    charged(bytes);
    return parsed.data;
  } catch {
    await cancel();
    throw Error(unavailable);
  } finally {
    signal.removeEventListener("abort", abort);
    body.releaseLock();
  }
}

/** Reuse the shared storage's canonical decoder with no write or lock capability. */
export function readInboxHeldOriginal(
  provider: "codex" | "gemini",
  projectId: string,
  sessionId: string,
  getItem: Storage["getItem"],
) {
  const expectedKey =
    provider === "codex"
      ? CODEX_CHAT_DECISION_IDENTITIES
      : GEMINI_CHAT_DECISION_IDENTITIES;
  const readOnly = {
    storage: {
      getItem(key: string) {
        if (key !== expectedKey) throw Error(unavailable);
        return getItem(key);
      },
      setItem() {
        throw Error("Inbox cannot write permission identities.");
      },
    },
    async withLock<T>(_work: () => T | Promise<T>): Promise<T> {
      throw Error("Inbox cannot reserve permission identities.");
    },
  };
  return provider === "codex"
    ? createCodexChatDecisionIdentities(readOnly).read(projectId, sessionId)
    : createGeminiChatDecisionIdentities(readOnly).read(projectId, sessionId);
}

/** Passed only to InboxClient, which pools each refresh. No SessionClient startup recovery or again tail. */
export function createInboxPermissionSessions(
  reader: OperatorRead = inboxOperatorRead,
) {
  const views = new Map<
    string,
    Pick<SessionProjectView, "records" | "loaded" | "loading" | "error">
  >();
  const generations = new Map<string, number>();
  const empty = () => ({
    records: [],
    loaded: false,
    loading: false,
    error: "Session list unavailable.",
  });
  return {
    project: (projectId: string) => views.get(projectId) ?? empty(),
    async refresh(projectId: string) {
      const generation = (generations.get(projectId) ?? 0) + 1;
      generations.set(projectId, generation);
      const prior = views.get(projectId) ?? empty();
      views.set(projectId, { ...prior, loading: true, error: "" });
      try {
        const raw = await readReply(
          reader,
          "/__agent-forge/projects/" +
            encodeURIComponent(projectId) +
            "/sessions",
          new AbortController().signal,
        );
        const records = ownedCodingSessionSchema.array().max(1000).parse(raw);
        if (
          records.some((row) => row.projectId !== projectId) ||
          new Set(records.map((row) => row.id)).size !== records.length
        )
          throw Error(unavailable);
        if (generations.get(projectId) === generation)
          views.set(projectId, {
            records,
            loaded: true,
            loading: false,
            error: "",
          });
      } catch {
        if (generations.get(projectId) === generation)
          views.set(projectId, {
            ...prior,
            loading: false,
            error: unavailable,
          });
      }
    },
  };
}

export interface InboxCompositionView {
  sourceGeneration: number;
  catalogRevision: number;
  loading: boolean;
  cards: readonly InboxCard[];
  coverage: readonly InboxCoverage[];
  complete: boolean;
  diagnostics: readonly string[];
}
export interface InboxCompositionInput {
  home: ProjectsHome | null;
  homeCurrent: boolean;
  sourceGeneration: number;
}
const sameCard = (a: InboxCard, b: InboxCard) =>
  a.projectId === b.projectId &&
  a.workspace === b.workspace &&
  a.sourceKind === b.sourceKind &&
  a.stableItemId === b.stableItemId &&
  a.sourceRevision === b.sourceRevision;
const stale = (card: InboxCard): InboxCard => ({
  ...card,
  sourceState: "unavailable",
  canSnooze: false,
  resolved: false,
});

/** Catalog-scoped source composition only. No action transport and no new acknowledgment epoch. */
export function createInboxSourceComposition(
  deps: {
    reader?: OperatorRead;
    usage?: () => UsageThresholdReportsInput;
    now?: () => number;
  } = {},
) {
  const reader = deps.reader ?? inboxOperatorRead;
  const clock = deps.now ?? Date.now;
  const usageCoverageScopes = new Map<number, string>();
  const usageWitnesses = new Map<
    string,
    { fingerprint: string; since: number; until: number; retired?: boolean }
  >();
  const usageCapture = () => {
    try {
      const captured = structuredClone(deps.usage?.() ?? null);
      if (
        captured &&
        new TextEncoder().encode(JSON.stringify(captured.data)).byteLength >
          maxReply
      )
        return null;
      return captured;
    } catch {
      return null;
    }
  };
  const fingerprint = (value: UsageThresholdReportsInput | null) =>
    JSON.stringify(
      value && [value.data, value.loading, value.failed, value.stale],
    );
  const witnessCurrent = (witness: {
    fingerprint: string;
    since: number;
    until: number;
    retired?: boolean;
  }) => {
    const now = clock();
    const current =
      Number.isFinite(now) &&
      now >= witness.since &&
      now <= witness.until &&
      witness.fingerprint === fingerprint(usageCapture());
    if (!current) witness.retired = true;
    return current && !witness.retired;
  };
  const snapshot = () => {
    const invalid = new Set(
      [...usageWitnesses]
        .filter(([, witness]) => !witnessCurrent(witness))
        .map(([scope]) => scope),
    );
    if (!invalid.size) return view;
    return freeze({
      ...view,
      complete: false,
      cards: view.cards.map((item) =>
        item.sourceKind === "usage-threshold" && invalid.has(key(item))
          ? stale(item)
          : item,
      ),
      coverage: view.coverage.map((item, index) =>
        item.sourceKind === "usage-threshold" &&
        invalid.has(usageCoverageScopes.get(index) ?? "")
          ? {
              ...item,
              state: "unavailable" as const,
              reason:
                "The captured usage report changed or expired. Refresh Inbox.",
            }
          : item,
      ),
    });
  };
  const checkpoints = new Map<
    string,
    ReturnType<typeof createInboxCheckpointClient>
  >();
  const cache = new Map<string, Map<Kind, readonly InboxCard[]>>();
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  let controller: AbortController | null = null,
    generation = 0,
    closed = false;
  let view: InboxCompositionView = freeze({
    sourceGeneration: 0,
    catalogRevision: -1,
    loading: false,
    cards: [],
    coverage: kinds.map((sourceKind) => ({
      sourceKind,
      state: "unavailable",
      reason: unavailable,
    })),
    complete: false,
    diagnostics: [unavailable],
  });
  const tell = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A subscriber does not own reads. */
      }
    }
  };
  const cached = () =>
    [...cache.values()].flatMap((families) =>
      [...families.values()].flatMap((cards) => cards.map(stale)),
    );
  const revoke = (input?: InboxCompositionInput) => {
    const old = controller;
    controller = null;
    usageWitnesses.clear();
    usageCoverageScopes.clear();
    const own = ++generation;
    view = freeze({
      ...view,
      sourceGeneration: input?.sourceGeneration ?? view.sourceGeneration,
      catalogRevision: input?.home?.catalog.revision ?? view.catalogRevision,
      loading: false,
      cards: cached(),
      coverage: kinds.map((sourceKind) => ({
        sourceKind,
        state: "unavailable",
        reason: unavailable,
      })),
      complete: false,
      diagnostics: [unavailable],
    });
    // Publish revocation before both observer callbacks and abort listeners.
    tell();
    for (const checkpoint of checkpoints.values()) checkpoint.invalidate();
    old?.abort();
    return own;
  };
  async function card(
    fact: Fact,
    projectName: string,
    observedAt: string,
  ): Promise<InboxCard> {
    const retainedOriginal =
      fact.sourceKind === "checkpoint-review" &&
      ["unknown", "prepared", "recovery-required"].includes(fact.reviewStatus);
    let destination: DesktopRoute["destination"] = "workbench";
    let selection: DesktopRoute["selection"] = null;
    if (
      fact.sourceKind === "bead-approval" ||
      fact.sourceKind === "halted-bead"
    )
      selection = { kind: "bead", id: fact.sourceIdentity.beadId };
    if (
      fact.sourceKind === "failed-gate" ||
      fact.sourceKind === "checkpoint-review"
    ) {
      destination = "runs";
      selection = { kind: "run", id: fact.sourceIdentity.runSlug };
    }
    if (fact.sourceKind === "council-verdict") destination = "reviews";
    if (fact.sourceKind === "usage-threshold") destination = "project-settings";
    return bindInboxCardIdentity({
      key: "",
      projectId: fact.projectId,
      workspace: fact.workspace,
      projectName,
      sourceKind: fact.sourceKind,
      stableItemId: fact.stableItemId,
      sourceRevision: fact.sourceRevision,
      title: fact.title,
      detail:
        fact.detail +
        (fact.sourceKind === "usage-threshold" ? " " + fact.limitation : "") +
        (fact.sourceKind === "council-verdict"
          ? " Open saved Council reviews to select the exact original " +
            fact.sourceIdentity.requestId +
            "."
          : fact.sourceKind === "stopped-shift"
            ? " Open shifts and select " + fact.sourceIdentity.shiftId + "."
            : ""),
      observedAt,
      sourceState: fact.fresh && fact.complete ? "current" : "unavailable",
      resolved: false,
      canSnooze:
        !retainedOriginal &&
        fact.status === "pending" &&
        fact.fresh &&
        fact.complete,
      canCheck: true,
      checkHref: desktopHref({
        destination,
        projectId: fact.projectId,
        selection,
      }),
      checkLabel:
        fact.sourceKind === "checkpoint-review" ? "Runs" : "Open source",
      notice: retainedOriginal,
    });
  }
  function refresh(
    inputValue: InboxCompositionInput,
  ): Promise<InboxCompositionView> {
    if (closed) return Promise.resolve(view);
    const input = structuredClone(inputValue);
    const capturedUsage = usageCapture();
    const own = revoke(input);
    if (own !== generation || closed) return Promise.resolve(view);
    const home = input.home;
    if (
      !home ||
      !input.homeCurrent ||
      !Number.isSafeInteger(input.sourceGeneration) ||
      input.sourceGeneration < 0 ||
      !Number.isSafeInteger(home.catalog.revision) ||
      home.catalog.revision < 0 ||
      home.catalog.projects.length > 32 ||
      new Set(home.catalog.projects.map((p) => p.id)).size !==
        home.catalog.projects.length
    )
      return Promise.resolve(view);
    const abort = new AbortController();
    controller = abort;
    const current = () => !closed && own === generation && controller === abort;
    view = freeze({ ...view, loading: true });
    tell();
    if (!current()) return Promise.resolve(view);
    let totalBytes = capturedUsage
      ? new TextEncoder().encode(JSON.stringify(capturedUsage.data)).byteLength
      : 0;
    const read = (path: string) =>
      withInboxReadSlot(async () => {
        if (!current() || abort.signal.aborted) throw Error(unavailable);
        return readReply(reader, path, abort.signal, (bytes) => {
          totalBytes += bytes;
          if (totalBytes > 16 * 1024 * 1024) throw Error(unavailable);
        });
      });
    const task = (async () => {
      const coverage: InboxCoverage[] = [],
        cards: InboxCard[] = [],
        diagnostics: string[] = [];
      const seenScopes = new Set<string>();
      for (const project of home.catalog.projects) {
        if (!current()) break;
        const summary = home.summaries.find(
          (item) => item.projectId === project.id,
        );
        const scope = {
          projectId: project.id,
          workspace: summary?.workspace ?? "",
        };
        const scopeKey = key(scope),
          root = "/__agent-forge/projects/" + encodeURIComponent(project.id);
        seenScopes.add(scopeKey);
        const prior =
          cache.get(scopeKey) ?? new Map<Kind, readonly InboxCard[]>();
        const next = new Map(prior);
        const family = (
          kind: Kind,
          complete: boolean,
          incoming: readonly InboxCard[],
          reason = unavailable,
        ) => {
          const selected = complete
            ? incoming
            : [...incoming.map(stale), ...(prior.get(kind) ?? []).map(stale)];
          const unique = [
            ...new Map(
              selected.map((item) => [
                JSON.stringify([item.stableItemId, item.sourceRevision]),
                item,
              ]),
            ).values(),
          ];
          cards.push(...unique);
          if (kind === "usage-threshold")
            usageCoverageScopes.set(coverage.length, scopeKey);
          coverage.push({
            sourceKind: kind,
            state: complete ? "current" : "unavailable",
            reason: complete
              ? "Verified for the catalog's served scope."
              : reason,
          });
          if (complete || unique.length) next.set(kind, unique);
        };
        if (
          !summary ||
          !project.workspaces.some(
            (item) => workspaceKey(item.root) === workspaceKey(scope.workspace),
          ) ||
          home.summaries.filter((item) => item.projectId === project.id)
            .length !== 1 ||
          (new Set([...cache.keys(), ...usageWitnesses.keys()]).size >= 64 &&
            !cache.has(scopeKey) &&
            !usageWitnesses.has(scopeKey))
        ) {
          for (const kind of kinds) family(kind, false, []);
          continue;
        }
        const inScope = (page: { projectId: string; workspace: string }) =>
          page.projectId === scope.projectId &&
          workspaceKey(page.workspace) === workspaceKey(scope.workspace);
        const attempt = async <T>(
          work: () => Promise<T>,
        ): Promise<T | null> => {
          try {
            return await work();
          } catch {
            return null;
          }
        };
        const [beads, workbench, shifts] = await Promise.all([
          attempt(async () => {
            const page = projectBeadsPageSchema.parse(
              await read(root + "/beads"),
            );
            if (!inScope(page) || !page.complete || page.problems.length)
              throw Error(unavailable);
            return page;
          }),
          attempt(async () => {
            const page = projectWorkbenchPageSchema.parse(
              await read(root + "/workbench"),
            );
            if (!inScope(page) || !page.complete || page.problems.length)
              throw Error(unavailable);
            return page;
          }),
          attempt(async () => {
            const page = projectShiftsPageSchema.parse(
              await read(root + "/shifts"),
            );
            if (page.projectId !== project.id) throw Error(unavailable);
            return page;
          }),
        ]);
        if (!current()) return snapshot();
        const projected = await projectInboxBeadShiftSources({
          scope,
          sourceGeneration: input.sourceGeneration,
          catalogRevision: home.catalog.revision,
          beads: source(beads),
          workbench: source(workbench),
          shifts: source(shifts),
        });
        if (!current()) return snapshot();
        for (const kind of [
          "bead-approval",
          "halted-bead",
          "stopped-shift",
        ] as const) {
          const complete =
            kind === "stopped-shift"
              ? projected.coverage.shifts.complete
              : projected.coverage.workbench.complete &&
                projected.coverage.beads.complete;
          const mapped = await Promise.all(
            projected.facts
              .filter((fact) => fact.sourceKind === kind)
              .map((fact) =>
                card(
                  fact,
                  project.name,
                  "updatedAt" in fact.sourceIdentity
                    ? fact.sourceIdentity.updatedAt
                    : (shifts?.items.find(
                        (row) =>
                          row.intent.shiftId ===
                          ("shiftId" in fact.sourceIdentity
                            ? fact.sourceIdentity.shiftId
                            : ""),
                      )?.observation.actual?.endedAt ??
                        shifts?.items.find(
                          (row) =>
                            row.intent.shiftId ===
                            ("shiftId" in fact.sourceIdentity
                              ? fact.sourceIdentity.shiftId
                              : ""),
                        )?.intent.createdAt ??
                        home.asOf),
                ),
              ),
          );
          family(kind, complete, mapped);
        }
        const gates = await attempt(async () => {
          const page = projectRunsPageSchema.parse(await read(root + "/runs"));
          if (
            !inScope(page) ||
            page.problems.length ||
            page.runs.length > 128 ||
            new Set(page.runs.map((row) => row.slug)).size !== page.runs.length
          )
            throw Error(unavailable);
          const found: InboxCard[] = [];
          for (const listed of page.runs) {
            const detail = projectRunDetailSchema.parse(
              await read(root + "/runs/" + encodeURIComponent(listed.slug)),
            );
            if (
              !inScope(detail) ||
              detail.checkout !== page.checkout ||
              JSON.stringify(detail.run) !== JSON.stringify(listed)
            )
              throw Error(unavailable);
            const result = await projectInboxGateSource({
              scope,
              sourceGeneration: input.sourceGeneration,
              catalogRevision: home.catalog.revision,
              runSlug: listed.slug,
              expectedCheckout: page.checkout,
              detail: source(detail),
            });
            if (!result.coverage.complete || !result.coverage.fresh)
              throw Error(unavailable);
            found.push(
              ...(await Promise.all(
                result.facts.map((fact) =>
                  card(fact, project.name, fact.sourceIdentity.gate.timestamp),
                ),
              )),
            );
          }
          const after = projectRunsPageSchema.parse(await read(root + "/runs"));
          if (
            !inScope(after) ||
            after.problems.length ||
            after.checkout !== page.checkout ||
            JSON.stringify(after.runs) !== JSON.stringify(page.runs)
          )
            throw Error(unavailable);
          return found;
        });
        if (!current()) return snapshot();
        family("failed-gate", gates !== null, gates ?? []);
        const councils = await attempt(async () => {
          const history = projectCouncilHistorySchema.parse(
            await read(root + "/council/reviews"),
          );
          if (
            !inScope(history) ||
            history.omitted !== 0 ||
            history.total !== history.items.length ||
            new Set(history.items.map((row) => row.requestId)).size !==
              history.items.length ||
            (history.activeRequestId !== null &&
              !history.items.some(
                (row) => row.requestId === history.activeRequestId,
              ))
          )
            throw Error(unavailable);
          const found: InboxCard[] = [];
          for (const row of history.items) {
            const path =
              root + "/council/reviews/" + encodeURIComponent(row.requestId);
            const original = projectCouncilOriginalReadSchema.parse(
              await read(path),
            );
            if (
              original.original.requestId !== row.requestId ||
              original.original.runId !== row.runId ||
              original.original.intentHash !== row.intentHash ||
              original.original.state !== row.state
            )
              throw Error(unavailable);
            await verifyProjectCouncilOriginalRead(
              original,
              scope.projectId,
              scope.workspace,
              row.requestId,
            );
            const locator = original.original.context.source.locator;
            let selectedBead = beads;
            if (
              original.original.context.source.kind === "bead" &&
              original.original.state === "completed"
            ) {
              if (parseBeadsIssueId(locator) !== locator)
                throw Error(unavailable);
              selectedBead = projectBeadsPageSchema.parse(
                await read(
                  root + "/beads?beadId=" + encodeURIComponent(locator),
                ),
              );
              if (!inScope(selectedBead)) throw Error(unavailable);
            }
            const result = projectCouncilRunReadSchema.parse(
              await read(path + "/run"),
            );
            const projection = await projectInboxCouncilSource({
              scope,
              requestId: row.requestId,
              sourceGeneration: input.sourceGeneration,
              catalogRevision: home.catalog.revision,
              original: source(original),
              result: source(result),
              bead: source(selectedBead),
            });
            if (projection.status === "unverified") throw Error(unavailable);
            found.push(
              ...(await Promise.all(
                projection.facts.map((fact) =>
                  card(fact, project.name, original.original.updatedAt),
                ),
              )),
            );
          }
          const after = projectCouncilHistorySchema.parse(
            await read(root + "/council/reviews"),
          );
          if (JSON.stringify(after) !== JSON.stringify(history))
            throw Error(unavailable);
          return found;
        });
        if (!current()) return snapshot();
        family("council-verdict", councils !== null, councils ?? []);
        let checkpoint = checkpoints.get(scopeKey);
        if (!checkpoint) {
          checkpoint = createInboxCheckpointClient(null, {
            reads: (id) => {
              const reads = createInboxCheckpointReads(id, reader);
              // Each method is exactly one complete protected read, not an aggregate refresh.
              return {
                runs: (signal) => withInboxReadSlot(() => reads.runs(signal)),
                beads: (signal) => withInboxReadSlot(() => reads.beads(signal)),
                detail: (slug, signal) =>
                  withInboxReadSlot(() => reads.detail(slug, signal)),
                association: (target, signal) =>
                  withInboxReadSlot(() => reads.association(target, signal)),
                retained: (signal) =>
                  withInboxReadSlot(() => reads.retained(signal)),
              } satisfies InboxCheckpointReads;
            },
          });
          checkpoints.set(scopeKey, checkpoint);
        }
        checkpoint.setContext({
          ...scope,
          catalogRevision: home.catalog.revision,
          archived: project.archived,
          active: true,
        });
        await checkpoint.refresh();
        if (!current()) return snapshot();
        const checkpointView = checkpoint.get();
        family(
          "checkpoint-review",
          checkpointView.complete,
          await Promise.all(
            checkpointView.facts.map((fact) =>
              card(
                fact,
                project.name,
                "publication" in fact.sourceIdentity
                  ? fact.sourceIdentity.publication.receipt.appliedAt
                  : fact.sourceIdentity.originalRead.original.createdAt,
              ),
            ),
          ),
        );
        const usageCards: InboxCard[] = [];
        let usageComplete = false;
        try {
          const configuration = inboxUsageRulesDocumentSchema.parse(
            await read(root + "/settings/usage-thresholds"),
          );
          const page = providerReadinessPageSchema.parse(capturedUsage?.data);
          const capturedFingerprint = fingerprint(capturedUsage);
          if (
            !capturedUsage ||
            capturedUsage.loading ||
            capturedUsage.failed ||
            capturedUsage.stale
          )
            throw Error(unavailable);
          const projection = await projectInboxUsageSource({
            scope,
            sourceGeneration: input.sourceGeneration,
            catalogRevision: home.catalog.revision,
            now: clock(),
            configuration: source(configuration),
            providers: source(page),
          });
          if (!current() || capturedFingerprint !== fingerprint(usageCapture()))
            throw Error(unavailable);
          let since = Date.parse(page.asOf),
            until = since + 30000;
          const observations = new Map<string, string>();
          for (const rule of configuration.rules.filter(
            (rule) => rule.enabled,
          )) {
            const report = page.providers
              .find((provider) => provider.provider === rule.provider)
              ?.usage.find(
                (report) =>
                  report.kind === rule.selector.kind &&
                  report.unit === rule.selector.unit &&
                  report.source === rule.selector.source &&
                  report.label === rule.selector.label &&
                  report.reported.basis === rule.selector.basis,
              );
            const observedAt = Date.parse(report?.observedAt ?? "");
            since = Math.max(since, observedAt);
            if (report?.observedAt)
              observations.set(rule.id, report.observedAt);
            until = Math.min(
              until,
              observedAt + 60000,
              report?.resetAt ? Date.parse(report.resetAt) - 1 : Infinity,
            );
          }
          const witness = { fingerprint: capturedFingerprint, since, until };
          usageComplete =
            projection.coverage.complete &&
            projection.coverage.fresh &&
            witnessCurrent(witness);
          if (usageComplete) {
            usageCards.push(
              ...(await Promise.all(
                projection.facts.map((fact) =>
                  card(
                    fact,
                    project.name,
                    observations.get(fact.sourceIdentity.ruleId) ?? page.asOf,
                  ),
                ),
              )),
            );
            if (!current() || !witnessCurrent(witness))
              throw Error(unavailable);
            usageWitnesses.set(scopeKey, witness);
          }
        } catch {
          usageComplete = false;
        }
        if (!current()) return snapshot();
        family(
          "usage-threshold",
          usageComplete,
          usageComplete ? usageCards : [],
          "The configured usage rules and captured provider report could not be verified together.",
        );
        if (current()) {
          const proposed = new Map(cache);
          proposed.set(scopeKey, next);
          const retained = [...proposed.values()].flatMap((families) =>
            [...families.values()].flatMap((items) => items),
          );
          if (retained.length > 10000) throw Error(unavailable);
          cache.set(scopeKey, next);
        }
      }
      for (const [scopeKey, families] of cache)
        if (!seenScopes.has(scopeKey))
          for (const [kind, prior] of families) {
            if (!prior.length) continue;
            cards.push(...prior.map(stale));
            coverage.push({
              sourceKind: kind,
              state: "unavailable",
              reason:
                "A retained source belongs to a project outside the current catalog read.",
            });
          }
      if (cards.length > 10000 || totalBytes > 16 * 1024 * 1024)
        throw Error(unavailable);
      for (const kind of kinds)
        if (!coverage.some((item) => item.sourceKind === kind))
          coverage.push({
            sourceKind: kind,
            state: "current",
            reason: "No catalog projects require this source read.",
          });
      if (current()) {
        diagnostics.push(
          ...coverage
            .filter((item) => item.state !== "current")
            .map((item) => item.reason),
        );
        view = freeze({
          sourceGeneration: input.sourceGeneration,
          catalogRevision: home.catalog.revision,
          loading: false,
          cards,
          coverage,
          complete: coverage.every((item) => item.state === "current"),
          diagnostics: [...new Set(diagnostics)],
        });
        view = snapshot();
        tell();
      }
      return snapshot();
    })().catch(() => {
      if (current()) {
        revoke(input);
      }
      return snapshot();
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  }
  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    invalidate() {
      if (!closed) revoke();
    },
    currentCard(
      candidate: InboxCard,
      sourceGeneration: number,
      catalogRevision: number,
    ) {
      if (
        view.loading ||
        view.sourceGeneration !== sourceGeneration ||
        view.catalogRevision !== catalogRevision
      )
        return null;
      if (candidate.sourceKind === "usage-threshold") {
        const witness = usageWitnesses.get(key(candidate));
        if (!witness || !witnessCurrent(witness)) return null;
      }
      return (
        view.cards.find(
          (item) =>
            sameCard(item, candidate) &&
            !item.notice &&
            item.sourceState === "current",
        ) ?? null
      );
    },
    async close() {
      if (!closed) {
        closed = true;
        revoke();
        listeners.clear();
      }
      await Promise.allSettled([...pending]);
      await Promise.allSettled(
        [...checkpoints.values()].map((checkpoint) => checkpoint.close()),
      );
    },
  };
}

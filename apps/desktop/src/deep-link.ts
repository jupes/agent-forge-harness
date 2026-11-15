import { z } from "zod";
import type { DesktopRoute } from "./navigation";

if (typeof window !== "undefined") z.config({ jitless: true });
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value));
const membership = z
  .object({
    complete: z.boolean(),
    ids: z
      .array(identifier)
      .max(1500)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const deepLinkIndexSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    projects: z
      .array(
        z
          .object({
            id: identifier,
            archived: z.boolean(),
            readable: z.boolean(),
            beads: membership,
            sessions: membership,
          })
          .strict(),
      )
      .max(100)
      .refine(
        (projects) =>
          new Set(projects.map((project) => project.id)).size ===
          projects.length,
      ),
  })
  .strict();
export type DeepLinkIndex = z.infer<typeof deepLinkIndexSchema>;
export type DeepLinkTarget = {
  kind: "project" | "bead" | "session";
  id: string;
};
export type DeepLinkResolution =
  | { state: "ready"; route: DesktopRoute }
  | {
      state: "blocked";
      reason: "invalid" | "missing" | "archived" | "ambiguous" | "unavailable";
    };

/** Product links contain one identifier and grant navigation only. */
export function parseDeepLink(input: unknown): DeepLinkTarget | null {
  if (typeof input !== "string" || input.length > 2048) return null;
  const match = /^agent-forge:\/\/(project|bead|session)\/([^/?#]+)$/.exec(
    input,
  );
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2] ?? "");
    if (id === "." || id === ".." || !identifier.safeParse(id).success)
      return null;
    const kind = match[1];
    return kind === "project" || kind === "bead" || kind === "session"
      ? { kind, id }
      : null;
  } catch {
    return null;
  }
}

/** The adapter must use canonical, protected producer reads; labels and prefixes are never ownership. */
export function resolveDeepLink(
  target: DeepLinkTarget,
  rawIndex: unknown,
): DeepLinkResolution {
  const parsed = deepLinkIndexSchema.safeParse(rawIndex);
  if (!parsed.success || !identifier.safeParse(target.id).success)
    return { state: "blocked", reason: "unavailable" };
  const projects = parsed.data.projects;
  const kind = target.kind;
  const source = kind === "bead" ? "beads" : "sessions";
  const matches = projects.filter((project) =>
    kind === "project"
      ? project.id === target.id
      : project[source].ids.includes(target.id),
  );
  if (matches.length > 1) return { state: "blocked", reason: "ambiguous" };
  if (
    kind !== "project" &&
    projects.some((project) => !project.readable || !project[source].complete)
  )
    return { state: "blocked", reason: "unavailable" };
  const owner = matches[0];
  if (!owner) return { state: "blocked", reason: "missing" };
  if (!owner.readable) return { state: "blocked", reason: "unavailable" };
  if (owner.archived) return { state: "blocked", reason: "archived" };
  return {
    state: "ready",
    route: {
      projectId: owner.id,
      destination:
        kind === "project"
          ? "overview"
          : kind === "bead"
            ? "beads"
            : "sessions",
      selection: kind === "project" ? null : { kind, id: target.id },
    },
  };
}

export type DeepLinkState = {
  phase: "idle" | "waiting" | "resolving" | "blocked" | "opened";
  target: DeepLinkTarget | null;
  reason?: Extract<DeepLinkResolution, { state: "blocked" }>["reason"];
};
export function createDeepLinkController(deps: {
  loadIndex(signal: AbortSignal, target: DeepLinkTarget): Promise<unknown>;
  navigate(route: DesktopRoute): void;
  changed(state: DeepLinkState): void;
}) {
  let connected = false,
    disposed = false,
    generation = 0;
  let active: AbortController | null = null;
  let current: DeepLinkState = { phase: "idle", target: null };
  const state = (): DeepLinkState => ({
    ...current,
    target: current.target ? { ...current.target } : null,
  });
  const tell = (next: DeepLinkState) => {
    current = next;
    if (!disposed) deps.changed(state());
  };
  const invalidate = () => {
    generation++;
    active?.abort();
    active = null;
  };
  const run = async () => {
    const target = current.target;
    if (disposed || !target) return;
    if (!connected) {
      tell({ phase: "waiting", target });
      return;
    }
    invalidate();
    const ticket = generation;
    const request = new AbortController();
    active = request;
    const live = () =>
      !disposed &&
      connected &&
      generation === ticket &&
      !request.signal.aborted;
    tell({ phase: "resolving", target });
    try {
      const index = await deps.loadIndex(request.signal, { ...target });
      if (!live()) return;
      const result = resolveDeepLink(target, index);
      if (result.state === "blocked")
        tell({ phase: "blocked", target, reason: result.reason });
      else {
        tell({ phase: "opened", target });
        if (live()) deps.navigate(result.route);
      }
    } catch {
      if (live()) tell({ phase: "blocked", target, reason: "unavailable" });
    } finally {
      if (active === request) active = null;
    }
  };
  const dismiss = () => {
    invalidate();
    tell({ phase: "idle", target: null });
  };
  return {
    state,
    async activate(raw: unknown) {
      if (disposed) return;
      invalidate();
      const target = parseDeepLink(raw);
      if (!target) {
        tell({ phase: "blocked", target: null, reason: "invalid" });
        return;
      }
      tell({ phase: "waiting", target });
      await run();
    },
    async setConnected(value: boolean) {
      if (disposed) return;
      connected = value;
      if (!connected && current.phase === "resolving") {
        invalidate();
        tell({ phase: "waiting", target: current.target });
      } else if (connected && current.phase === "waiting") await run();
    },
    async retry() {
      if (!disposed && current.phase === "blocked" && current.target)
        await run();
    },
    dismiss() {
      if (!disposed) dismiss();
    },
    dispose() {
      if (!disposed) {
        dismiss();
        disposed = true;
      }
    },
  };
}

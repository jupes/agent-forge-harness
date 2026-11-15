import { z } from "zod";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "../../../scripts/sessions/identity-protocol";
import {
  managedShiftHref,
  managedShiftSelection,
} from "./managed-shift-navigation";
import { desktopHref, desktopRoute } from "./navigation";

export const sessionWindowTargetSchema = z
  .object({
    projectId: sessionProjectIdSchema,
    sessionId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    shiftRequestId: sessionRequestIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.shiftRequestId ||
      ownedSessionIdSchema.safeParse(value.sessionId).success,
    "Shift window needs its exact owned session identity.",
  );
export type SessionWindowTarget = z.infer<typeof sessionWindowTargetSchema>;
export function sessionWindowHref(raw: SessionWindowTarget): string {
  const target = sessionWindowTargetSchema.parse(raw);
  const href = target.shiftRequestId
    ? managedShiftHref({
        projectId: target.projectId,
        sessionId: target.sessionId,
        requestId: target.shiftRequestId,
      })
    : desktopHref({
        projectId: target.projectId,
        destination: "sessions",
        selection: { kind: "session", id: target.sessionId },
      });
  return href + "&sessionWindow=1";
}
/** Presentation context only. Existing server reads still establish membership and authority. */
export function readSessionWindowTarget(
  raw: unknown,
): SessionWindowTarget | null {
  const parsed = sessionWindowTargetSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function sessionWindowContext(surface: {
  __AF_SESSION_WINDOW_TARGET__?: unknown;
}) {
  const target = readSessionWindowTarget(surface.__AF_SESSION_WINDOW_TARGET__);
  return {
    target,
    invalid:
      Object.hasOwn(surface, "__AF_SESSION_WINDOW_TARGET__") && target === null,
  };
}
export function sessionWindowMatches(
  target: SessionWindowTarget,
  hash: string,
): boolean {
  try {
    const route = desktopRoute(hash),
      url = new URL(hash.replace(/^#/, ""), "http://127.0.0.1");
    const allowed = new Set([
      "selectionKind",
      "selectionId",
      "sessionWindow",
      ...(target.shiftRequestId ? ["shiftRequestId"] : []),
    ]);
    if (
      [...url.searchParams.keys()].some(
        (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
      ) ||
      url.searchParams.get("sessionWindow") !== "1"
    )
      return false;
    const shift = managedShiftSelection(hash);
    return (
      !shift.error &&
      route.projectId === target.projectId &&
      route.destination === "sessions" &&
      route.selection?.kind === "session" &&
      route.selection.id === target.sessionId &&
      (shift.selection?.requestId ?? null) === (target.shiftRequestId ?? null)
    );
  } catch {
    return false;
  }
}
const windowReplySchema = z
  .object({
    state: z.enum(["created", "focused", "opening"]),
    label: z.string().regex(/^session-popout-[1-9][0-9]*$/),
  })
  .strict();
export type SessionWindowInvoke = (
  command: string,
  args: { request: SessionWindowTarget },
) => Promise<unknown>;
export function nativeSessionWindowInvoke(
  surface: unknown,
): SessionWindowInvoke | null {
  if (
    !surface ||
    typeof surface !== "object" ||
    !("invoke" in surface) ||
    typeof surface.invoke !== "function"
  )
    return null;
  const invoke = surface.invoke.bind(surface);
  return (command, args) => invoke(command, args);
}
export function createSessionWindowClient(
  invoke: SessionWindowInvoke | null,
  changed: () => void,
) {
  const state = {
    busy: false,
    message: invoke
      ? ""
      : "Pop-out session windows are available in the Windows app.",
  };
  return {
    state,
    available: invoke !== null,
    async open(raw: SessionWindowTarget) {
      if (!invoke || state.busy) return;
      const parsed = sessionWindowTargetSchema.safeParse(raw);
      if (!parsed.success) {
        state.message = "This session address is invalid.";
        changed();
        return;
      }
      state.busy = true;
      state.message = "Opening this session in a compact window…";
      changed();
      try {
        const reply = windowReplySchema.parse(
          await invoke("open_session_popout", { request: parsed.data }),
        );
        state.message =
          reply.state === "created"
            ? "Session window opened. The existing session continues in both views."
            : reply.state === "focused"
              ? "The existing session window is now in front."
              : "This session window is already opening. No second window was created.";
      } catch {
        state.message =
          "The window result could not be confirmed. Check open Forge windows before choosing Pop out again; no session or provider was started.";
      } finally {
        state.busy = false;
        changed();
      }
    },
  };
}

import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "../../../scripts/sessions/identity-protocol";
import { desktopHref, desktopRoute } from "./navigation";

/** Navigation addresses only. Every private read still verifies the original and full attempt. */
export interface ManagedShiftSelection {
  projectId: string;
  requestId: string;
  sessionId: string | null;
}

export function managedShiftHref(selection: ManagedShiftSelection): string {
  const href = desktopHref({
    projectId: selection.projectId,
    destination: selection.sessionId === null ? "workbench" : "sessions",
    selection: selection.sessionId
      ? { kind: "session", id: selection.sessionId }
      : null,
  });
  return `${href}${href.includes("?") ? "&" : "?"}shiftRequestId=${encodeURIComponent(selection.requestId)}`;
}

export function managedShiftSelection(hash: string): {
  selection: ManagedShiftSelection | null;
  error: string;
} {
  const unavailable = {
    selection: null,
    error:
      "This Shift link is invalid. No original or private attempt was selected.",
  };
  try {
    const url = new URL(hash.replace(/^#/, ""), "http://127.0.0.1"),
      ids = url.searchParams.getAll("shiftRequestId");
    if (!ids.length) return { selection: null, error: "" };
    const route = desktopRoute(hash),
      requestId = ids[0];
    if (
      ids.length !== 1 ||
      !sessionProjectIdSchema.safeParse(route.projectId).success ||
      !sessionRequestIdSchema.safeParse(requestId).success ||
      !["sessions", "workbench"].includes(route.destination) ||
      url.searchParams.getAll("selectionKind").length > 1 ||
      url.searchParams.getAll("selectionId").length > 1 ||
      (route.destination === "workbench"
        ? url.searchParams.has("selectionKind") ||
          url.searchParams.has("selectionId")
        : route.selection?.kind !== "session" ||
          !ownedSessionIdSchema.safeParse(route.selection.id).success)
    )
      return unavailable;
    return {
      selection: {
        projectId: route.projectId!,
        requestId: requestId!,
        sessionId:
          route.destination === "sessions" ? route.selection!.id : null,
      },
      error: "",
    };
  } catch {
    return unavailable;
  }
}

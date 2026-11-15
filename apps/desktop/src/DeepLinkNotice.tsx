import { useLayoutEffect, useRef } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import type { DeepLinkState } from "./deep-link";
import { type DesktopRoute, desktopHref } from "./navigation";

const reasons = {
  invalid: "This Forge link is invalid.",
  missing: "This item is not available in the connected project catalog.",
  archived:
    "This item belongs to an archived project. Find its saved project in Projects.",
  ambiguous:
    "This item belongs to more than one project. Choose its project in Projects.",
  unavailable:
    "Could not verify this item. Check the hearth connection and try again.",
};
export function DeepLinkNotice({
  state,
  retry,
  dismiss,
  route,
}: {
  state: DeepLinkState;
  route: DesktopRoute;
  retry(): Promise<void>;
  dismiss(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const destinationRendered =
      state.route && desktopHref(state.route) === desktopHref(route);
    if (
      state.phase === "waiting" ||
      state.phase === "blocked" ||
      (state.phase === "opened" && destinationRendered)
    )
      panel.current?.focus();
  }, [state, route]);
  if (state.phase === "idle") return null;
  const message =
    state.phase === "waiting"
      ? "Waiting for the connected hearth to open this Forge link."
      : state.phase === "resolving"
        ? "Finding the project for this Forge link…"
        : state.phase === "opened"
          ? "Opened the linked " + (state.target?.kind ?? "item") + "."
          : reasons[state.reason ?? "unavailable"];
  return (
    <section ref={panel} tabIndex={-1} aria-label="Forge link">
      <EmptyState title={message} live>
        {state.phase === "blocked" && state.reason === "unavailable" && (
          <Button onClick={() => void retry()}>Try again</Button>
        )}
        {state.phase === "blocked" && (
          <Button
            onClick={() => {
              dismiss();
              window.location.hash = desktopHref({
                destination: "projects",
                projectId: null,
                selection: null,
              });
            }}
          >
            Open Projects
          </Button>
        )}
        <Button onClick={dismiss}>Dismiss</Button>
      </EmptyState>
    </section>
  );
}

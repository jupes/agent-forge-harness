import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { ConnectionBanner, useDesktopRecovery } from "./ConnectionBanner";
import { DesktopFrame } from "./DesktopFrame";
import {
  desktopHref,
  desktopRoute,
  GLOBAL_DESTINATIONS,
  navigateGlobal,
  PROJECT_DESTINATIONS,
} from "./navigation";

/** Desktop routing stays separate from the ordinary dashboard's legacy URLs and snapshot mode. */
export function DesktopApp(): JSX.Element {
  const [route, setRoute] = useState(() => desktopRoute(window.location.hash));
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1201px)").matches,
  );
  const recovery = useDesktopRecovery();
  useEffect(() => {
    const changed = () => setRoute(desktopRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1200px)");
    const collapse = () => {
      if (compact.matches) {
        const focused = document.activeElement?.closest(
          ".af-desktop-inspector",
        );
        setInspectorOpen(false);
        if (focused)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                'main button[aria-label="Show inspector"]',
              )
              ?.focus(),
          );
      }
    };
    compact.addEventListener("change", collapse);
    collapse();
    return () => compact.removeEventListener("change", collapse);
  }, []);
  const global = GLOBAL_DESTINATIONS.find(
    (entry) => entry.id === route.destination,
  );
  const name =
    global?.label ??
    PROJECT_DESTINATIONS.find((entry) => entry.id === route.destination)
      ?.label ??
    "Projects";
  return (
    <DesktopFrame
      route={route}
      project={null}
      connectionLabel={
        recovery?.busy
          ? "Restarting"
          : (recovery?.connection.label ?? "Connecting")
      }
      inspectorOpen={inspectorOpen}
      onInspectorToggle={() => {
        setInspectorOpen(!inspectorOpen);
        if (inspectorOpen)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                'main button[aria-label="Show inspector"]',
              )
              ?.focus(),
          );
      }}
    >
      <ConnectionBanner />
      {global ? (
        <EmptyState
          title={`${name} unavailable`}
          hint={`${name} is not available in this build.`}
        />
      ) : (
        <EmptyState
          title="Project unavailable"
          hint="This project could not be loaded. Choose a project to continue."
        >
          <Button href={desktopHref(navigateGlobal(route, "projects"))}>
            Choose project
          </Button>
        </EmptyState>
      )}
    </DesktopFrame>
  );
}

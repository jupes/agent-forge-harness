import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { installCopyDelegation } from "./copy-to-clipboard";
import { AppShell, type ShellLocation } from "./ds/AppShell";
import { useShellChrome } from "./use-shell-chrome";

export interface StandalonePageProps {
  active: Extract<ShellLocation, "plan-review" | "council">;
  title: string;
  blurb?: ComponentChildren;
  children: ComponentChildren;
}

/**
 * The frame for a page that lives in its own document.
 *
 * Plan review and Council keep their own HTML entry points — they carry heavy,
 * dev-server-bound islands that the SPA bundle has no reason to pull in — but
 * they render through the same shell, so navigation and the global actions are
 * identical everywhere.
 */
export function StandalonePage({
  active,
  title,
  blurb,
  children,
}: StandalonePageProps): JSX.Element {
  const chrome = useShellChrome();

  useEffect(() => installCopyDelegation(document.body), []);

  return (
    <AppShell
      active={active}
      title={title}
      blurb={blurb}
      onRefreshSnapshot={chrome.refresh}
      refreshing={chrome.refreshing}
      snapshotLabel={chrome.snapshotLabel}
      snapshotIso={chrome.snapshotIso}
    >
      {children}
    </AppShell>
  );
}

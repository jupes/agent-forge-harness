import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { installCopyDelegation } from "./copy-to-clipboard";
import { AppShell, type ShellLocation } from "./ds/AppShell";
import { useShellChrome } from "./use-shell-chrome";

export interface StandalonePageProps {
  active: Extract<ShellLocation, "council">;
  title: string;
  blurb?: ComponentChildren;
  children: ComponentChildren;
}

/**
 * The frame for a page that lives in its own document.
 *
 * Council keeps its own HTML entry point — it carries a heavy, dev-server-bound
 * island that the SPA bundle has no reason to pull in — but it renders through
 * the same shell, so navigation and the global actions are identical
 * everywhere.
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

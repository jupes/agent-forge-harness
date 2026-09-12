import type { ComponentChildren, JSX } from "preact";
import { hrefFor, ROUTES, type RouteId } from "../router";
import { Icon, type IconName } from "./Icon";

/**
 * Where the shell is mounted. The SPA passes a route id; the two standalone
 * documents pass their own name so their nav entry highlights correctly.
 */
export type ShellLocation = RouteId | "plan-review" | "council";

/** Destinations that live in their own document rather than the SPA. */
const STANDALONE = [
  {
    id: "plan-review",
    label: "Plan review",
    icon: "file-text",
    href: "plan-review.html",
    group: "work",
  },
  {
    id: "council",
    label: "Council",
    icon: "users-three",
    href: "council.html",
    group: "work",
  },
] as const satisfies readonly {
  id: ShellLocation;
  label: string;
  icon: IconName;
  href: string;
  group: "work" | "author";
}[];

export interface AppShellProps {
  active: ShellLocation;
  title: ComponentChildren;
  blurb?: ComponentChildren;
  children: ComponentChildren;
  /** Controls rendered beside the page title. */
  headerActions?: ComponentChildren;
  /** Rebuilds the Beads snapshot. Omitted when no dev server can serve it. */
  onRefreshSnapshot?: () => void;
  refreshing?: boolean;
  /** Human-readable snapshot time; falsy renders the not-loaded state. */
  snapshotLabel?: string;
  /** Raw ISO timestamp, surfaced in the label's title attribute. */
  snapshotIso?: string;
}

interface NavEntry {
  id: ShellLocation;
  label: string;
  icon: IconName;
  href: string;
  group: "work" | "author";
}

/**
 * The page frame: navigation, global actions, header, content.
 *
 * Every document mounts this — the SPA, `plan-review.html` and `council.html`
 * alike. That is the point: Council's hand-written nav previously omitted five
 * destinations *and* the snapshot controls, and a shell that only owned links
 * would have reproduced that gap. Global actions live here too.
 */
export function AppShell({
  active,
  title,
  blurb,
  children,
  headerActions,
  onRefreshSnapshot,
  refreshing,
  snapshotLabel,
  snapshotIso,
}: AppShellProps): JSX.Element {
  // From a standalone document, SPA links must carry the document too.
  const fromDocument = active === "plan-review" || active === "council";

  const entries: NavEntry[] = [
    ...ROUTES.map((route) => ({
      id: route.id as ShellLocation,
      label: route.label,
      icon: route.icon,
      href: hrefFor(route.id, { fromDocument }),
      group: route.group,
    })),
    ...STANDALONE.map((page) => ({ ...page })),
  ];

  const groups: { key: "work" | "author"; heading: string }[] = [
    { key: "work", heading: "Work" },
    { key: "author", heading: "Author" },
  ];

  return (
    <div class="af-shell">
      {/* A button, not an anchor: the SPA routes on the hash, so an
          href="#af-main" link would navigate away from the current page. */}
      <button
        type="button"
        class="af-skip-link"
        onClick={() => {
          const main = document.getElementById("af-main");
          main?.focus();
          main?.scrollIntoView({ block: "start" });
        }}
      >
        Skip to content
      </button>

      <nav class="af-nav" aria-label="Main">
        <a class="af-brand" href={fromDocument ? "index.html" : "#/dashboard"}>
          <span class="af-brand-mark" aria-hidden="true">
            <Icon name="hammer" size={14} />
          </span>
          Agent Forge
        </a>

        <div class="af-nav-groups">
          {groups.map((group) => (
            <div key={group.key} class="af-nav-group">
              <p class="af-nav-heading">{group.heading}</p>
              {entries
                .filter((entry) => entry.group === group.key)
                .map((entry) => (
                  <a
                    key={entry.id}
                    class={`af-nav-item${entry.id === active ? " af-nav-item-active" : ""}`}
                    href={entry.href}
                    aria-current={entry.id === active ? "page" : undefined}
                  >
                    <Icon name={entry.icon} size={15} />
                    {entry.label}
                  </a>
                ))}
            </div>
          ))}
        </div>

        <div class="af-shell-actions">
          <p
            class="af-shell-snapshot"
            aria-live="polite"
            title={snapshotIso ? `ISO: ${snapshotIso}` : undefined}
          >
            {snapshotLabel || "Snapshot: not loaded"}
          </p>
          {onRefreshSnapshot ? (
            <button
              type="button"
              class="af-btn af-btn-primary af-shell-refresh"
              onClick={onRefreshSnapshot}
              disabled={refreshing}
              title="Regenerate docs/data/beads.json from Beads. Needs the local dev server; otherwise run bun run build-pages."
            >
              <Icon name="arrows-clockwise" size={13} />
              {refreshing ? "Refreshing…" : "Refresh snapshot"}
            </button>
          ) : null}
        </div>
      </nav>

      {/* tabIndex -1: focusable by the skip link, not added to the tab order. */}
      <main id="af-main" class="af-main" tabIndex={-1}>
        <header class="af-page-header">
          <div class="af-page-heading">
            <h1 class="af-page-title">{title}</h1>
            {blurb !== undefined ? <p class="af-page-blurb">{blurb}</p> : null}
          </div>
          {headerActions !== undefined ? (
            <div class="af-page-actions">{headerActions}</div>
          ) : null}
        </header>
        <div class="af-page-body">{children}</div>
      </main>

      {/* Every page can raise a copy confirmation; only index.html used to. */}
      <div id="copy-toast" class="af-toast" role="status" aria-live="polite" />
    </div>
  );
}

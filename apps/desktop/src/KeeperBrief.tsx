import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { KeeperBrief } from "../../../types/keeper-brief";
import type { KeeperReadiness } from "../../../types/keeper-recovery";
import type { KeeperClient } from "./keeper-client";
import { desktopHref } from "./navigation";
import { openProject } from "./projects-model";
import "./brief.css";

export function briefAge(asOf: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(asOf)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago${hours >= 3 ? " · older brief" : ""}`;
}

export function briefFollowup(brief: KeeperBrief): string {
  const lines = [
    brief.content.summary,
    ...(["moving", "waiting", "stuck"] as const).flatMap((section) =>
      brief.content[section].map((item) => `${section}: ${item.text}`),
    ),
  ];
  return `Brief as of ${brief.snapshot.asOf} · ${brief.snapshot.scope.label}\n${lines.map((line) => `> ${line}`).join("\n")}\n\nMy question: `;
}

export function briefHeadline(summary: string): string {
  return (
    summary.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0] ??
    summary.split(/\r?\n/)[0] ??
    ""
  ).trim();
}

export function KeeperBriefCard({
  brief,
  client,
  onNavigate,
}: {
  brief: KeeperBrief;
  client: KeeperClient;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const { snapshot, content } = brief;
  return (
    <article
      class="af-brief-card"
      aria-label="Keeper brief card"
      data-brief-id={brief.requestId}
    >
      <h3>
        Brief ·{" "}
        <time dateTime={snapshot.asOf}>
          {new Date(snapshot.asOf).toLocaleString()}
        </time>
      </h3>
      <p class="af-brief-source">
        {briefAge(snapshot.asOf)} · {snapshot.scope.label} ·{" "}
        {snapshot.scope.epicCount} epics · {snapshot.scope.repositoryCount}{" "}
        repositories
      </p>
      <p class="af-brief-source">
        From{" "}
        {Object.entries(snapshot.observed)
          .map(
            ([key, value]) =>
              `${value === null ? "— unavailable" : value} ${key}`,
          )
          .join(" · ")}
      </p>
      <p>{content.summary}</p>
      <div class="af-brief-sections">
        {(
          [
            ["moving", "Moving"],
            ["waiting", "Waiting on you"],
            ["stuck", "Stuck"],
          ] as const
        ).map(([section, label]) => (
          <section key={section}>
            <h4>{label}</h4>
            {content[section].length ? (
              <ul>
                {content[section].map((item, index) => (
                  <li key={index}>
                    <p>{item.text}</p>
                    <div class="af-brief-links">
                      {[...new Set(item.facts)].map((factIndex) => {
                        const fact = snapshot.facts[factIndex];
                        return fact ? (
                          <a
                            key={factIndex}
                            href={desktopHref({
                              projectId: snapshot.projectId,
                              destination:
                                fact.object.kind === "session"
                                  ? "sessions"
                                  : fact.object.kind === "run"
                                    ? "runs"
                                    : fact.object.kind === "event"
                                      ? "activity"
                                      : "beads",
                              selection: fact.object,
                            })}
                            onClick={onNavigate}
                          >
                            {fact.object.kind} {fact.object.id}
                          </a>
                        ) : null;
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="af-brief-source">No matching evidence in this read.</p>
            )}
          </section>
        ))}
      </div>
      <details>
        <summary>
          Source scope and limitations{snapshot.complete ? "" : " · incomplete"}
        </summary>
        <p>
          Activity from{" "}
          <time dateTime={snapshot.since}>
            {new Date(snapshot.since).toLocaleString()}
          </time>
          . Saved scope: {snapshot.scope.label}; epics{" "}
          {snapshot.scope.epicIds.join(", ") || "none"}. Catalog revision{" "}
          {snapshot.catalogRevision}.
        </p>
        <ul>
          {snapshot.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
      <Button
        href={openProject(snapshot.projectId, "keeper")}
        onClick={() => {
          const draft = client.get(snapshot.projectId).draft;
          client.draft(
            snapshot.projectId,
            `${draft ? `${draft}\n\n` : ""}${briefFollowup(brief)}`,
          );
          onNavigate?.();
        }}
      >
        Ask a follow-up
      </Button>
    </article>
  );
}

export function KeeperBriefAvailability({
  projectId,
  readiness,
  onNavigate,
}: {
  projectId: string;
  readiness: KeeperReadiness | undefined;
  onNavigate?: (() => void) | undefined;
}): JSX.Element | null {
  if (readiness?.canStart) return null;
  return (
    <p
      class="af-brief-availability"
      data-readiness={readiness ? "unavailable" : "unknown"}
      role="status"
    >
      {readiness
        ? `Brief refresh is unavailable. ${readiness.reason}`
        : "Keeper readiness has not been verified. Check it before requesting a brief."}{" "}
      <Button
        href={openProject(projectId, "keeper")}
        onClick={() => onNavigate?.()}
      >
        Review Keeper readiness
      </Button>
    </p>
  );
}

export function KeeperBriefPanel({
  projectId,
  client,
  showCard = true,
  onNavigate,
}: {
  projectId: string;
  client: KeeperClient;
  showCard?: boolean;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const [earlier, setEarlier] = useState("");
  useEffect(() => {
    void client.loadBriefs(projectId);
  }, [client, projectId]);
  const state = client.get(projectId),
    data = state.briefs;
  const recovery = client.recovery?.get(projectId).page;
  const readiness = recovery?.choices.find(
    (choice) => choice.smith.name === recovery.selectedSmith,
  )?.readiness;
  const selected =
    data?.earlier.find((brief) => brief.requestId === earlier) ?? data?.latest;
  const pending =
    data?.refresh &&
    ["accepted", "running", "cancelling"].includes(data.refresh.phase);
  return (
    <section
      class="af-brief-panel"
      aria-label="Keeper brief"
      aria-busy={state.briefsLoading}
    >
      <div class="af-brief-toolbar">
        <h2>Keeper brief</h2>
        <Button
          disabled={!client.canRefreshBrief(projectId)}
          onClick={() => {
            void client.refreshBrief(projectId);
          }}
        >
          Refresh brief
        </Button>
      </div>
      {client.recovery && (
        <KeeperBriefAvailability
          projectId={projectId}
          readiness={readiness}
          onNavigate={onNavigate}
        />
      )}
      {state.briefsLoading && <p role="status">Reading saved briefs…</p>}
      {state.briefsError && (
        <p role="status">
          {state.briefsError}{" "}
          <Button
            onClick={() => {
              void client.loadBriefs(projectId, true);
            }}
          >
            Retry brief read
          </Button>
        </p>
      )}
      {!data?.latest && !state.briefsLoading && (
        <p>No confirmed brief yet. Refresh brief to ask the Keeper for one.</p>
      )}
      {pending && (
        <p role="status">
          Preparing a brief in the standing conversation. The previous brief
          remains available.
        </p>
      )}
      {data?.refresh?.problem && <p role="status">{data.refresh.problem}</p>}
      {state.pendingKind === "briefs" && !state.pending && state.notice && (
        <p role="status">{state.notice}</p>
      )}
      {state.pending && state.pendingKind === "briefs" && (
        <p role="status">
          {state.notice}{" "}
          <Button
            disabled={state.posting}
            onClick={() => {
              void client.check(projectId);
            }}
          >
            Check original refresh
          </Button>{" "}
          <Button
            disabled={state.posting}
            onClick={() => {
              void client.retryOriginal(projectId);
            }}
          >
            Retry original refresh
          </Button>
        </p>
      )}
      {data && data.earlier.length > 0 && (
        <label>
          Earlier briefs{" "}
          <select
            aria-label="Earlier briefs"
            value={earlier}
            onChange={(event) => setEarlier(event.currentTarget.value)}
          >
            <option value="">Latest brief</option>
            {data.earlier.map((brief) => (
              <option key={brief.requestId} value={brief.requestId}>
                {new Date(brief.snapshot.asOf).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (showCard || earlier) && (
        <KeeperBriefCard
          brief={selected}
          client={client}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

/** Read only visible home cards; retain the root client's private projection cache. */
export function ProjectKeeperLine({
  projectId,
  client,
}: {
  projectId: string;
  client: KeeperClient;
}): JSX.Element {
  const node = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void client.loadBriefs(projectId);
      }
    });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [client, projectId]);
  const state = client.get(projectId),
    brief = state.briefs?.latest;
  return (
    <p ref={node} class="af-project-keeper">
      Keeper —{" "}
      {brief ? (
        <>
          {briefHeadline(brief.content.summary)}{" "}
          <time dateTime={brief.snapshot.asOf}>
            {briefAge(brief.snapshot.asOf)}
          </time>
        </>
      ) : state.briefsLoading ? (
        "reading saved brief…"
      ) : state.briefsError ? (
        "brief unavailable; open the project to retry."
      ) : (
        "no confirmed brief yet."
      )}
    </p>
  );
}

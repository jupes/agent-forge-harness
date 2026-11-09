import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import {
  type OperatorRead,
  operatorPost,
  operatorRead,
} from "../../../docs/js/operator";
import {
  appStream,
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import {
  createKeeperClient,
  type KeeperScheduleContext,
} from "./keeper-client";

/** App lifetime, rather than route/drawer lifetime, owns pending requests and drafts. */
export function useKeeper(
  projectId: string | null,
  writesAllowed: boolean,
  context: KeeperScheduleContext | null = null,
) {
  const stream = appStream();
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0);
  const client = useRef<ReturnType<typeof createKeeperClient> | null>(null);
  client.current ??= createKeeperClient({
    canWrite: () => writes.current,
    scheduleSource: () => ({
      routeKey: window.location.hash,
      status: stream.getState().status,
      foreground: document.visibilityState !== "hidden",
    }),
    readSchedule: (id, signal) => readKeeperSchedule(operatorRead, id, signal),
    requestId: () => crypto.randomUUID(),
    readRecovery: (id, requestId) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/recovery${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    readBriefs: (id) =>
      readOperatorRoute(`/projects/${encodeURIComponent(id)}/keeper/briefs`, {
        ...pageReads(),
        fetch: operatorRead,
      }),
    readBriefIntent: (id, requestId) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/brief-intents${requestId ? `/${encodeURIComponent(requestId)}` : ""}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    readObjects: (id, query) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/read?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
        pageReads(),
      ),
    stream: (id) =>
      fetchTransport(
        `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/events`,
        { fetch: operatorRead },
      ),
    read: (id, query) => {
      const params = new URLSearchParams({
        after: String(query.after),
        limit: "100",
      });
      if (query.requestId) params.set("requestId", query.requestId);
      return readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper?${params}`,
        { ...pageReads(), fetch: operatorRead },
      );
    },
    post: (id, action, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/${action}`,
            body,
          ),
        "Check the original request in this conversation before trying again.",
      ),
  });
  const keeper = client.current;
  keeper.adoptScheduleContext(context);
  useLayoutEffect(() => {
    const leave = keeper.subscribe(() => paint((value) => value + 1));
    const unbind = bindKeeperScheduleSources(keeper, {
      onStatus: (listener) => stream.subscribe(listener),
      onHash(listener) {
        window.addEventListener("hashchange", listener);
        return () => window.removeEventListener("hashchange", listener);
      },
      onForeground(listener) {
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("pageshow", listener);
        return () => {
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("pageshow", listener);
        };
      },
    });
    return () => {
      unbind();
      leave();
    };
  }, [keeper, stream]);
  useLayoutEffect(() => {
    keeper.activate(projectId);
    void keeper.flushSchedule();
  });
  return keeper;
}

/** Production source ownership is separately testable without mounting hooks. */
export function bindKeeperScheduleSources(
  keeper: ReturnType<typeof createKeeperClient>,
  sources: {
    onStatus(listener: () => void): () => void;
    onHash(listener: () => void): () => void;
    onForeground(listener: () => void): () => void;
  },
) {
  let closed = false;
  const leaves: Array<() => void> = [];
  const change = (kind: "status" | "hash" | "foreground") => {
    if (!closed) {
      keeper.scheduleSourceChanged(kind);
      void keeper.flushSchedule();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    keeper.dispose();
    for (const leave of leaves) leave();
  };
  try {
    leaves.push(sources.onStatus(() => change("status")));
    leaves.push(sources.onHash(() => change("hash")));
    leaves.push(sources.onForeground(() => change("foreground")));
    change("status");
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

export async function readKeeperSchedule(
  read: OperatorRead,
  id: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await read(
    `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/schedule`,
    { method: "GET", signal },
    { maxBodyBytes: 65_536 },
  );
  const raw: unknown = await response.json();
  if (
    response.status !== 200 ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 3 ||
    !("ok" in raw) ||
    raw.ok !== true ||
    !("error" in raw) ||
    raw.error !== null ||
    !("data" in raw)
  )
    throw Error("Unverified schedule read");
  return raw.data;
}

import { useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { MAX_OBSERVATION_INDEX_BYTES } from "../../../scripts/projects/session-observations-protocol";
import { createDeepLinkController, type DeepLinkState } from "./deep-link";
import { readDeepLinkIndex } from "./deep-link-reader";
import { desktopHref } from "./navigation";
import { readSessionObservationResponse } from "./session-observation-response";

const envelope = z
  .object({
    version: z.literal(1),
    generation: z.string().regex(/^[a-z0-9-]{1,100}$/),
    sequence: z.number().int().positive().max(4294967295),
    uri: z.string().max(2048),
  })
  .strict();
const acknowledgment = envelope.pick({ generation: true, sequence: true });
const ACK_KEY = "agent-forge.deep-link.ack.v1";
declare global {
  interface Window {
    __AGENT_FORGE_DEEP_LINK__?: unknown;
  }
}

/** Main-window navigation only. It has no write, provider or process-control port. */
export function useDeepLink(options: {
  enabled: boolean;
  connected: boolean;
  workspace: string | null;
  refreshProjects(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const expectedHash = useRef<string | null>(null);
  const pending = useRef<z.infer<typeof envelope> | null>(null);
  const generation = useRef<string | null>(null);
  const [state, setState] = useState<DeepLinkState>({
    phase: "idle",
    target: null,
  });
  const acknowledge = () => {
    if (!pending.current) return;
    try {
      window.sessionStorage.setItem(
        ACK_KEY,
        JSON.stringify({
          generation: pending.current.generation,
          sequence: pending.current.sequence,
        }),
      );
    } catch {
      /* A blocked browser store never grants any additional action. */
    }
  };
  const held = useRef<ReturnType<typeof createDeepLinkController> | null>(null);
  if (!held.current)
    held.current = createDeepLinkController({
      async loadIndex(signal, target) {
        const workspace = latest.current.workspace;
        if (!latest.current.enabled || !workspace) throw Error("Unavailable");
        const deadline = new AbortController();
        const timer = window.setTimeout(() => deadline.abort(), 20000);
        const combined = AbortSignal.any([signal, deadline.signal]);
        let rejectAbort = () => {};
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(Error("Link lookup was canceled."));
          if (combined.aborted) rejectAbort();
          else combined.addEventListener("abort", rejectAbort, { once: true });
        });
        const read = (path: string, requestSignal: AbortSignal) => {
          const fetchProtected = (url: string, init?: RequestInit) =>
            operatorRead(
              url,
              {
                ...init,
                signal: AbortSignal.any([
                  requestSignal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              },
              path.endsWith("/session-observations")
                ? { maxBodyBytes: MAX_OBSERVATION_INDEX_BYTES + 1024 }
                : undefined,
            );
          const limits = {
            ...pageReads(),
            fetch: fetchProtected,
            timeoutMs: 15000,
          };
          return path.endsWith("/session-observations")
            ? readHearth(
                "/__agent-forge" + path,
                (response) => readSessionObservationResponse(response, "index"),
                limits,
              )
            : readOperatorRoute<unknown>(path, limits);
        };
        try {
          const data = await Promise.race([
            readDeepLinkIndex({ target, workspace, signal: combined, read }),
            aborted,
          ]);
          if (
            !latest.current.enabled ||
            !latest.current.connected ||
            latest.current.workspace !== workspace
          )
            throw Error("Unavailable");
          return data;
        } finally {
          window.clearTimeout(timer);
          combined.removeEventListener("abort", rejectAbort);
          deadline.abort();
        }
      },
      navigate(route) {
        expectedHash.current = desktopHref(route);
        window.location.hash = expectedHash.current;
        latest.current.refreshProjects();
      },
      changed(next) {
        if (next.phase === "opened" || next.phase === "blocked") acknowledge();
        if (mounted.current) setState(next);
      },
    });
  const owner = held.current;
  useEffect(() => {
    void owner.setConnected(false);
    if (options.enabled && options.connected && options.workspace)
      void owner.setConnected(true);
  }, [owner, options.enabled, options.connected, options.workspace]);
  useEffect(() => {
    if (!options.enabled) return;
    const accept = (raw: unknown) => {
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return;
      const value = parsed.data;
      if (generation.current && generation.current !== value.generation) return;
      generation.current = value.generation;
      if (pending.current && pending.current.sequence >= value.sequence) return;
      try {
        const text = window.sessionStorage.getItem(ACK_KEY);
        const ack = text ? acknowledgment.safeParse(JSON.parse(text)) : null;
        if (
          ack?.success &&
          ack.data.generation === value.generation &&
          ack.data.sequence >= value.sequence
        )
          return;
      } catch {
        /* An invalid acknowledgment is ignored; no URI is stored. */
      }
      pending.current = value;
      void owner.activate(value.uri);
    };
    const opened = (event: Event) => {
      if (event instanceof CustomEvent) accept(event.detail);
    };
    const navigated = () => {
      if (expectedHash.current === window.location.hash) {
        expectedHash.current = null;
        return;
      }
      expectedHash.current = null;
      acknowledge();
      owner.dismiss();
    };
    window.addEventListener("agent-forge-deep-link", opened);
    window.addEventListener("hashchange", navigated);
    accept(window.__AGENT_FORGE_DEEP_LINK__);
    return () => {
      window.removeEventListener("agent-forge-deep-link", opened);
      window.removeEventListener("hashchange", navigated);
    };
  }, [owner, options.enabled]);
  useEffect(
    () => () => {
      mounted.current = false;
      owner.dispose();
    },
    [owner],
  );
  return {
    state,
    retry: () => owner.retry(),
    dismiss: () => {
      acknowledge();
      owner.dismiss();
    },
  };
}

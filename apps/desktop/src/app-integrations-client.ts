import {
  type IntegrationClient,
  type IntegrationPending,
  type IntegrationReason,
  type IntegrationReview,
  integrationAuthorizationSchema,
  integrationEnvelope,
  integrationOutcomeSchema,
  integrationPendingSchema,
  integrationReviewSchema,
} from "../../../types/app-integrations";
export interface IntegrationView {
  client: IntegrationClient;
  phase:
    | "idle"
    | "reading"
    | "review"
    | "authorizing"
    | "saving"
    | "checking"
    | "configured"
    | "not-attempted"
    | "unknown"
    | "blocked";
  review: IntegrationReview | null;
  pending: IntegrationPending | null;
  error: IntegrationReason | null;
}
export interface IntegrationClientDeps {
  client: IntegrationClient;
  nativeAvailable(): boolean;
  review(client: IntegrationClient): Promise<unknown>;
  authorize(input: {
    requestId: string;
    client: IntegrationClient;
  }): Promise<unknown>;
  commit(requestId: string): Promise<unknown>;
  recover(requestId: string): Promise<unknown>;
  pending: {
    read(): unknown;
    write(value: IntegrationPending): void;
    clear(): void;
  };
  now?(): number;
  changed?(): void;
}
export function createAppIntegrationsClient(deps: IntegrationClientDeps) {
  let connected = true,
    disposed = false,
    epoch = 0;
  let view: IntegrationView = Object.freeze({
    client: deps.client,
    phase: "idle",
    review: null,
    pending: null,
    error: null,
  });
  const now = deps.now ?? Date.now;
  const canAct = () => {
    try {
      const available = deps.nativeAvailable();
      return available && connected && !disposed;
    } catch {
      return false;
    }
  };
  const live = (ticket: number) => canAct() && !disposed && ticket === epoch;
  const paint = (patch: Partial<IntegrationView>) => {
    view = Object.freeze({ ...view, ...patch });
    if (!disposed) {
      try {
        deps.changed?.();
      } catch {
        /* Observers never change a write outcome. */
      }
    }
  };
  const clear = () => {
    try {
      deps.pending.clear();
    } catch {
      /* Stale recovery metadata grants no write. */
    }
  };
  const finish = (raw: unknown, pending: IntegrationPending) => {
    const result = integrationEnvelope(integrationOutcomeSchema).parse(raw);
    if (
      !result.ok ||
      result.data.requestId !== pending.requestId ||
      result.data.client !== deps.client ||
      result.data.scopeKey !== pending.scopeKey
    )
      throw Error("Unverified outcome");
    if (result.data.state === "unknown")
      paint({
        phase: "unknown",
        pending,
        review: null,
        error: result.data.reason ?? "unavailable",
      });
    else {
      clear();
      paint({
        phase:
          result.data.state === "confirmed" ? "configured" : "not-attempted",
        pending: null,
        review: null,
        error: result.data.reason,
      });
    }
  };
  const client = {
    get state() {
      return view;
    },
    async review() {
      if (
        disposed ||
        view.pending ||
        ["authorizing", "saving", "checking"].includes(view.phase)
      )
        return;
      if (!canAct()) {
        paint({
          phase: "blocked",
          review: null,
          error: connected ? "native-unavailable" : "disconnected",
        });
        return;
      }
      const ticket = ++epoch;
      paint({ phase: "reading", review: null, error: null });
      try {
        const result = integrationEnvelope(integrationReviewSchema).parse(
          await deps.review(deps.client),
        );
        if (!live(ticket)) return;
        if (!result.ok) {
          paint({ phase: "blocked", error: result.error });
          return;
        }
        const data = result.data;
        if (data.client !== deps.client) throw Error("Wrong client");
        if (data.state === "configured")
          paint({ phase: "configured", error: null });
        else if (data.state === "pending") {
          const pending = Object.freeze(
            integrationPendingSchema.parse({
              schemaVersion: 1,
              client: data.client,
              requestId: data.requestId,
              scopeKey: data.scopeKey,
            }),
          );
          try {
            deps.pending.write(pending);
          } catch {
            /* Native recovery remains available for the retained request. */
          }
          if (live(ticket))
            paint({ phase: "unknown", pending, review: null, error: null });
        } else
          paint({
            phase: "review",
            review: Object.freeze({ ...data }),
            error: null,
          });
      } catch {
        if (live(ticket))
          paint({ phase: "blocked", error: "invalid-response" });
      }
    },
    async confirm() {
      const reviewed = view.review;
      if (disposed || view.phase !== "review" || !reviewed || !canAct()) return;
      if (now() >= reviewed.expiresAt) {
        paint({ phase: "blocked", review: null, error: "expired" });
        return;
      }
      const ticket = ++epoch;
      paint({ phase: "authorizing", error: null });
      try {
        const result = integrationEnvelope(
          integrationAuthorizationSchema,
        ).parse(
          await deps.authorize({
            requestId: reviewed.requestId,
            client: deps.client,
          }),
        );
        if (!live(ticket)) return;
        if (
          !result.ok ||
          result.data.requestId !== reviewed.requestId ||
          result.data.client !== deps.client
        )
          throw Error("Unverified authorization");
      } catch {
        if (live(ticket))
          paint({
            phase: "not-attempted",
            review: null,
            error: "authorization-unavailable",
          });
        return;
      }
      if (!live(ticket)) return;
      if (now() >= reviewed.expiresAt) {
        paint({ phase: "not-attempted", review: null, error: "expired" });
        return;
      }
      const pending = Object.freeze(
        integrationPendingSchema.parse({
          schemaVersion: 1,
          client: deps.client,
          requestId: reviewed.requestId,
          scopeKey: reviewed.scopeKey,
        }),
      );
      try {
        deps.pending.write(pending);
      } catch {
        paint({
          phase: "not-attempted",
          review: null,
          error: "recovery-unavailable",
        });
        return;
      }
      if (!live(ticket)) {
        clear();
        paint({
          phase: "not-attempted",
          pending: null,
          review: null,
          error: "cancelled",
        });
        return;
      }
      paint({ phase: "saving", pending, review: null });
      if (!live(ticket)) {
        clear();
        paint({
          phase: "not-attempted",
          pending: null,
          review: null,
          error: "cancelled",
        });
        return;
      }
      try {
        const result = await deps.commit(pending.requestId);
        if (live(ticket)) finish(result, pending);
      } catch {
        if (live(ticket))
          paint({
            phase: "unknown",
            pending,
            review: null,
            error: "unavailable",
          });
      }
    },
    async recover() {
      const pending = view.pending;
      if (
        !pending ||
        disposed ||
        ["authorizing", "saving", "checking"].includes(view.phase)
      )
        return;
      if (!canAct()) {
        paint({
          phase: "unknown",
          review: null,
          error: connected ? "native-unavailable" : "disconnected",
        });
        return;
      }
      const ticket = ++epoch;
      paint({ phase: "checking", review: null, error: null });
      if (!live(ticket)) return;
      try {
        const result = await deps.recover(pending.requestId);
        if (live(ticket)) finish(result, pending);
      } catch {
        if (live(ticket))
          paint({
            phase: "unknown",
            pending,
            review: null,
            error: "recovery-unavailable",
          });
      }
    },
    setConnected(value: boolean) {
      connected = value;
      if (!value) {
        epoch++;
        paint({
          phase: view.pending ? "unknown" : "blocked",
          review: null,
          error: "disconnected",
        });
      }
    },
    dispose() {
      disposed = true;
      epoch++;
    },
  };
  try {
    const parsed = integrationPendingSchema.safeParse(deps.pending.read());
    if (parsed.success && parsed.data.client === deps.client) {
      view = Object.freeze({
        ...view,
        phase: "unknown",
        pending: Object.freeze(parsed.data),
      });
    }
  } catch {
    /* Corrupt local metadata grants neither a read nor a write. */
  }
  return client;
}

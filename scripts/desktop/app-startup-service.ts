import { isAbsolute, join } from "node:path";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  type StartupBackend,
  type StartupObservation,
  type StartupRecord,
  type StartupStatus,
  startupRecordSchema,
  startupRequestSchema,
  startupStatusSchema,
} from "./app-startup-protocol";
export class AppStartupError extends Error {
  constructor(
    readonly status: 400 | 409 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}
const MARKER = "app-startup-v1\n";
const unavailable = () =>
  new AppStartupError(
    503,
    "Startup registration or its private history could not be verified. No registration change was started by this request.",
  );
const unknown = () =>
  new AppStartupError(
    504,
    "Startup registration outcome is unknown. Check its status; do not repeat the request.",
  );
type Available = Extract<StartupStatus, { capability: "available" }>;
export function createAppStartupService(options: {
  backend?: StartupBackend | undefined;
  now?: () => Date;
  write?: typeof writeOwnerOnly;
}) {
  const backend = options.backend,
    now = options.now ?? (() => new Date());
  const abort = new AbortController(),
    inflight = new Set<Promise<unknown>>();
  const operations = new Set<Promise<void>>();
  let closed = false,
    held = false;
  function io<T>(call: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(unavailable());
    const promise = call();
    inflight.add(promise);
    void promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    );
    return promise;
  }
  function observe(value: StartupObservation): StartupObservation {
    if (
      !/^[a-f0-9]{64}$/.test(value.installationKey) ||
      !isAbsolute(value.coordinationHome) ||
      value.coordinationHome.length > 32768 ||
      !["enabled", "disabled", "conflict"].includes(value.registration)
    )
      throw unavailable();
    return value;
  }
  function readRecord(home: string): StartupRecord {
    try {
      const stored = readHomeFileBounded(
        home,
        join(home, "startup-registration.json"),
        4096,
      );
      const marker = readHomeFileBounded(
        home,
        join(home, "startup-registration.initialized"),
        64,
      );
      if (stored.problem || marker.problem) throw unavailable();
      if (stored.text === null && marker.text === null)
        return { version: 1, revision: 0, last: null };
      if (stored.text === null || marker.text !== MARKER) throw unavailable();
      const record = startupRecordSchema.parse(JSON.parse(stored.text));
      if (record.revision === 0) throw unavailable();
      return record;
    } catch {
      throw unavailable();
    }
  }
  function status(
    observation: StartupObservation,
    record: StartupRecord,
  ): Available {
    return startupStatusSchema.parse({
      capability: "available",
      installationKey: observation.installationKey,
      registration: observation.registration,
      fingerprint:
        observation.registration === "enabled"
          ? observation.installationKey
          : observation.registration === "disabled"
            ? "absent"
            : null,
      record,
      checkedAt: now().toISOString(),
      canSave:
        !closed &&
        !held &&
        observation.registration !== "conflict" &&
        record.last?.state !== "pending",
    }) as Available;
  }
  function publish(home: string, record: StartupRecord) {
    const candidate = startupRecordSchema.parse(record);
    (options.write ?? writeOwnerOnly)(
      join(home, "startup-registration.json"),
      JSON.stringify(candidate),
    );
    if (JSON.stringify(readRecord(home)) !== JSON.stringify(candidate))
      throw unknown();
  }
  return {
    async read(): Promise<StartupStatus> {
      if (closed) throw unavailable();
      if (!backend) return { capability: "unsupported" };
      try {
        const observation = observe(await io(() => backend.read(abort.signal)));
        return status(observation, readRecord(observation.coordinationHome));
      } catch {
        throw unavailable();
      }
    },
    async write(raw: unknown): Promise<Available> {
      let finish = () => {};
      const operation = new Promise<void>((done) => {
        finish = done;
      });
      operations.add(operation);
      try {
        const parsed = startupRequestSchema.safeParse(raw);
        if (!parsed.success)
          throw new AppStartupError(
            400,
            "Invalid startup setting or reviewed status.",
          );
        if (!backend || closed) throw unavailable();
        if (held) throw unknown();
        let attempted = false,
          confirmedRefusal = false;
        try {
          const first = observe(await io(() => backend.read(abort.signal)));
          if (closed) throw unavailable();
          ensurePrivateHome(first.coordinationHome);
          const locked = await withQueueLock(
            join(first.coordinationHome, "startup-registration.lock"),
            async () => {
              if (closed) throw unavailable();
              if (held) throw unknown();
              const observation = observe(
                await io(() => backend.read(abort.signal)),
              );
              if (closed || abort.signal.aborted) throw unavailable();
              if (observation.coordinationHome !== first.coordinationHome)
                throw unavailable();
              const current = readRecord(first.coordinationHome),
                request = parsed.data;
              if (current.last?.state === "pending") throw unknown();
              const observed = status(observation, current);
              if (
                request.installationKey !== observed.installationKey ||
                request.expectedRevision !== current.revision ||
                request.expectedFingerprint !== observed.fingerprint ||
                observation.registration === "conflict" ||
                current.last?.request.requestId === request.requestId
              )
                throw new AppStartupError(
                  409,
                  "Startup registration changed or belongs to another installation. Check status before reviewing a new setting.",
                );
              const pending: StartupRecord = {
                version: 1,
                revision: current.revision + 1,
                last: {
                  request,
                  startedAt: now().toISOString(),
                  state: "pending",
                },
              };
              attempted = true;
              (options.write ?? writeOwnerOnly)(
                join(
                  first.coordinationHome,
                  "startup-registration.initialized",
                ),
                MARKER,
              );
              publish(first.coordinationHome, pending);
              if (closed || abort.signal.aborted) throw unknown();
              const result = await io(() =>
                backend.set(
                  request.enabled,
                  observation.registration as "enabled" | "disabled",
                  abort.signal,
                ),
              );
              if (
                closed ||
                result.outcome === "unconfirmed" ||
                result.observation === null ||
                !pending.last
              )
                throw unknown();
              const after = observe(result.observation);
              if (
                after.coordinationHome !== first.coordinationHome ||
                after.installationKey !== observation.installationKey
              )
                throw unknown();
              if (
                result.outcome === "completed" &&
                after.registration !==
                  (request.enabled ? "enabled" : "disabled")
              )
                throw unknown();
              const terminal: StartupRecord = {
                ...pending,
                last: { ...pending.last, state: result.outcome },
              };
              publish(first.coordinationHome, terminal);
              if (result.outcome === "refused") {
                confirmedRefusal = true;
                throw new AppStartupError(
                  409,
                  "Registration changed before the native write. No registration change was made by this request. Check status again.",
                );
              }
              return status(after, terminal);
            },
            { waitMs: 1000 },
          );
          if (!locked.ok) throw unavailable();
          return locked.value;
        } catch (error) {
          if (attempted) {
            // A fully published explicit pre-effect native refusal is the sole post-intent no-write case.
            if (
              confirmedRefusal &&
              error instanceof AppStartupError &&
              error.status === 409
            )
              throw error;
            held = true;
            throw unknown();
          }
          if (error instanceof AppStartupError) throw error;
          throw unavailable();
        }
      } finally {
        finish();
        operations.delete(operation);
      }
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled([...operations, ...inflight]);
    },
  };
}

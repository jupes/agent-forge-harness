import { z } from "zod";
import {
  type LoginProvider,
  loginProviderSchema,
  loginRequestIdSchema,
  type ProviderLogin,
  providerLoginPageSchema,
  providerLoginSchema,
} from "../../../scripts/providers/login-protocol";

export const PROVIDER_LOGIN_IDENTITIES =
  "agent-forge.provider-login-identities.v1";
const identitySchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    provider: loginProviderSchema,
    requestId: loginRequestIdSchema,
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
const savedSchema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(256) })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((row) => `${row.scope}:${row.provider}`))
        .size === value.records.length &&
      new Set(value.records.map((row) => row.requestId)).size ===
        value.records.length,
  );
type View = {
  identity: Identity | null;
  receipt: ProviderLogin | null;
  busy: boolean;
  ready: boolean;
  notice: string | null;
};
const empty = (): View => ({
  identity: null,
  receipt: null,
  busy: false,
  ready: false,
  notice: null,
});

/** Browser metadata only. No automatic POST, even after reload or a protected404. */
export function createProviderLoginClient(deps: {
  scope: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
  read(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<Response>;
  mint(): string;
  changed(): void;
}) {
  const views: Record<LoginProvider, View> = {
    claude: empty(),
    codex: empty(),
  };
  let refresh: Promise<void> | null = null;
  const stored = () => {
    if (!deps.storage)
      throw Error(
        "Sign-in identity storage is unavailable; the original must be saved before a terminal can open.",
      );
    const text = deps.storage.getItem(PROVIDER_LOGIN_IDENTITIES);
    if (text === null) return savedSchema.parse({ version: 1, records: [] });
    let raw: unknown;
    try {
      if (text.length > 100000) throw Error("Full identities");
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Saved sign-in identities could not be verified. Their bytes have been kept.",
      );
    }
    const parsed = savedSchema.safeParse(raw);
    if (!parsed.success)
      throw Error(
        "Saved sign-in identities conflict or use an unsupported version. Their bytes have been kept.",
      );
    return parsed.data;
  };
  const save = (value: z.infer<typeof savedSchema>) => {
    const text = JSON.stringify(savedSchema.parse(value));
    if (!deps.storage || text.length > 100000)
      throw Error("The original sign-in identity could not be saved.");
    deps.storage.setItem(PROVIDER_LOGIN_IDENTITIES, text);
    if (deps.storage.getItem(PROVIDER_LOGIN_IDENTITIES) !== text)
      throw Error(
        "The original sign-in identity could not be saved and verified.",
      );
  };
  const identity = (provider: LoginProvider) =>
    structuredClone(
      stored().records.find(
        (row) => row.scope === deps.scope && row.provider === provider,
      ) ?? null,
    );
  const notify = () => deps.changed();
  const problem = (
    provider: LoginProvider,
    message = "The original sign-in outcome could not be verified. Check it before opening another terminal.",
  ) => {
    views[provider].notice = message;
    notify();
  };
  async function accept(
    provider: LoginProvider,
    expected: Identity,
    value: unknown,
  ) {
    const parsed = providerLoginSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.provider !== provider ||
      parsed.data.requestId !== expected.requestId
    )
      throw Error("The original sign-in receipt did not match.");
    await deps.withLock(() => {
      const current = stored(),
        held = current.records.find(
          (row) => row.scope === deps.scope && row.provider === provider,
        );
      if (!held || held.requestId !== expected.requestId) return;
      if (["closed", "interrupted"].includes(parsed.data.phase))
        save({
          version: 1,
          records: current.records.filter((row) => row !== held),
        });
      views[provider].receipt = parsed.data;
      views[provider].notice =
        parsed.data.phase === "closed"
          ? `${parsed.data.stopped ? "Sign-in terminal closed by request." : parsed.data.timedOut ? "Sign-in terminal reached its time limit." : "Sign-in terminal closed."} Run doctor to check authentication.`
          : parsed.data.phase === "interrupted"
            ? "The original host no longer owns this terminal. Run doctor before opening another sign-in flow."
            : "Complete the vendor's own sign-in window, then run doctor. Terminal contents stay in that window.";
    });
    notify();
  }
  async function check(provider: LoginProvider) {
    const held = identity(provider);
    if (!held) return;
    try {
      await accept(
        provider,
        held,
        await deps.read(`/providers/${provider}/sign-in/${held.requestId}`),
      );
    } catch {
      problem(provider);
    }
  }
  async function send(provider: LoginProvider, held: Identity, stop = false) {
    try {
      const response = await deps.post(
        `/__agent-forge/providers/${provider}/sign-in${stop ? `/${held.requestId}/stop` : ""}`,
        stop ? {} : { requestId: held.requestId },
      );
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch {
        throw Error("Unverified reply");
      }
      if (
        !response.ok ||
        !envelope ||
        typeof envelope !== "object" ||
        !("ok" in envelope) ||
        envelope.ok !== true ||
        !("data" in envelope)
      )
        throw Error("Sign-in outcome is unverified");
      await accept(provider, held, envelope.data);
    } catch {
      problem(provider);
    }
  }
  async function busy(provider: LoginProvider, work: () => Promise<void>) {
    if (views[provider].busy) return;
    views[provider].busy = true;
    notify();
    try {
      await work();
    } catch {
      problem(
        provider,
        "The original sign-in identity could not be saved or checked. Saved identities were kept; check the original before trying again.",
      );
    } finally {
      views[provider].busy = false;
      notify();
    }
  }
  return {
    get(provider: LoginProvider): View {
      try {
        return { ...views[provider], identity: identity(provider) };
      } catch {
        return {
          ...views[provider],
          identity: null,
          ready: false,
          notice:
            "Saved sign-in identities are unavailable. No new terminal can be opened.",
        };
      }
    },
    check: (provider: LoginProvider) => busy(provider, () => check(provider)),
    retry: (provider: LoginProvider) =>
      busy(provider, async () => {
        const held = identity(provider);
        if (held) await send(provider, held);
      }),
    stop: (provider: LoginProvider) =>
      busy(provider, async () => {
        const held = identity(provider);
        if (held) await send(provider, held, true);
      }),
    start: (provider: LoginProvider) =>
      busy(provider, async () => {
        if (!views[provider].ready) return;
        const held = await deps.withLock(() => {
          const value = stored(),
            existing = value.records.find(
              (row) => row.scope === deps.scope && row.provider === provider,
            );
          if (existing) return { value: existing, created: false };
          if (value.records.length >= 256)
            throw Error("Saved sign-in identities are full.");
          const next = identitySchema.parse({
            scope: deps.scope,
            provider,
            requestId: deps.mint(),
          });
          save({ version: 1, records: [...value.records, next] });
          return { value: next, created: true };
        });
        if (held.created) await send(provider, held.value);
        else await check(provider);
      }),
    refresh(): Promise<void> {
      refresh ??= (async () => {
        try {
          const page = providerLoginPageSchema.parse(
            await deps.read("/providers/sign-in"),
          );
          await deps.withLock(() => {
            const value = stored();
            let changed = false;
            for (const provider of ["claude", "codex"] as const) {
              const original = page.records
                .filter(
                  (row) =>
                    row.provider === provider &&
                    !["closed", "interrupted"].includes(row.phase),
                )
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
              if (
                original &&
                !value.records.some(
                  (row) =>
                    row.scope === deps.scope && row.provider === provider,
                )
              ) {
                value.records.push(
                  identitySchema.parse({
                    scope: deps.scope,
                    provider,
                    requestId: original.requestId,
                  }),
                );
                changed = true;
              }
            }
            if (changed) save(value);
          });
          for (const provider of ["claude", "codex"] as const) {
            views[provider].ready = true;
            if (!views[provider].busy) {
              if (identity(provider)) await check(provider);
              else if (views[provider].receipt) {
                const original = page.records.find(
                  (row) =>
                    row.provider === provider &&
                    row.requestId === views[provider].receipt?.requestId,
                );
                if (
                  original &&
                  ["closed", "interrupted"].includes(original.phase)
                ) {
                  views[provider].receipt = original;
                  views[provider].notice =
                    "The original sign-in terminal closed. Run doctor to check authentication.";
                }
              }
            }
          }
        } catch {
          for (const provider of ["claude", "codex"] as const) {
            views[provider].ready = false;
            views[provider].notice =
              "Sign-in originals could not be read. Refresh before opening another terminal.";
          }
        } finally {
          notify();
          refresh = null;
        }
      })();
      return refresh;
    },
  };
}
export type ProviderLoginClient = ReturnType<typeof createProviderLoginClient>;

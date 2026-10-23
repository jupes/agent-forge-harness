import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import {
  createProviderLoginClient,
  PROVIDER_LOGIN_IDENTITIES,
  type ProviderLoginClient,
} from "./provider-login-client";

/** Shares the app's operator client; only metadata is retained before an explicit sign-in POST. */
export function useProviderLogins(workspace: string | undefined) {
  const [, redraw] = useState(0),
    client = useRef<ProviderLoginClient | null>(null);
  useEffect(() => {
    let current = true,
      owned: ProviderLoginClient | null = null;
    client.current = null;
    const refresh = () => {
      if (document.visibilityState === "visible") void owned?.refresh();
    };
    const changed = (event: StorageEvent) => {
      if (event.key === PROVIDER_LOGIN_IDENTITIES) void owned?.refresh();
    };
    void (async () => {
      if (!workspace) return;
      const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(workspace),
        ),
        scope = [...new Uint8Array(digest)]
          .map((part) => part.toString(16).padStart(2, "0"))
          .join("");
      if (!current) return;
      let storage: Storage | null = null;
      try {
        storage = window.localStorage;
      } catch {
        /* no effect without verified storage */
      }
      owned = createProviderLoginClient({
        scope,
        storage,
        mint: () => crypto.randomUUID(),
        changed: () => {
          if (current) redraw((value) => value + 1);
        },
        read: (path) =>
          readOperatorRoute(path, { ...pageReads(), fetch: operatorRead }),
        post: operatorPost,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error("Cross-window sign-in ownership is unavailable.");
          return navigator.locks.request(PROVIDER_LOGIN_IDENTITIES, work);
        },
      });
      client.current = owned;
      await owned.refresh();
    })().catch(() => {
      if (current) redraw((value) => value + 1);
    });
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", refresh);
      if (client.current === owned) client.current = null;
    };
  }, [workspace]);
  return client.current;
}

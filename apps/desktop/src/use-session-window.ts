import { useRef, useState } from "preact/hooks";
import {
  createSessionWindowClient,
  nativeSessionWindowInvoke,
  sessionWindowContext,
} from "./session-window";

export function useSessionWindow() {
  const surface = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __AF_SESSION_WINDOW_TARGET__?: unknown;
  };
  const { target, invalid } = useRef(sessionWindowContext(surface)).current;
  const [, changed] = useState(0);
  const client = useRef<ReturnType<typeof createSessionWindowClient> | null>(
    null,
  );
  client.current ??= createSessionWindowClient(
    target || invalid
      ? null
      : nativeSessionWindowInvoke(surface.__TAURI_INTERNALS__),
    () => changed((value) => value + 1),
  );
  return { target, invalid, client: client.current };
}

import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  REFETCH_WINDOW_MS,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import {
  DEFAULT_APP_APPEARANCE,
  effectiveAppTheme,
} from "../../../scripts/projects/app-appearance-protocol";
import { createAppAppearanceClient } from "./app-appearance-client";
import "./app-appearance.css";

export function useAppAppearance(connected: boolean) {
  const writable = useRef(connected);
  writable.current = connected;
  const [, changed] = useState(0);
  const ref = useRef<ReturnType<typeof createAppAppearanceClient> | null>(null);
  ref.current ??= createAppAppearanceClient({
    read: () =>
      readOperatorRoute<unknown>("/app-settings/appearance", {
        ...pageReads(),
        fetch: (path, init) => operatorRead(path, init, { maxBodyBytes: 8192 }),
      }),
    post: (body) =>
      operatorPost("/__agent-forge/app-settings/appearance", body),
    canWrite: () => writable.current,
    changed: () => changed((value) => value + 1),
  });
  const client = ref.current;
  const [systemLight, setSystemLight] = useState(
    () => window.matchMedia("(prefers-color-scheme: light)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => setSystemLight(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (connected) void client.check();
  }, [client, connected]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (document.visibilityState === "visible" && writable.current)
        void client.check();
    };
    const stop = appStream().watch(["operator.action"], () => {
      clearTimeout(timer);
      timer = setTimeout(check, REFETCH_WINDOW_MS);
    });
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop();
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      client.dispose();
    };
  }, [client]);
  const appearance = client.state.current?.appearance ?? DEFAULT_APP_APPEARANCE;
  const effective = effectiveAppTheme(appearance, systemLight);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.afDesktop = "";
    root.dataset.afTheme = effective;
    root.dataset.afDensity = appearance.density;
  }, [effective, appearance.density]);
  return { client, effective };
}

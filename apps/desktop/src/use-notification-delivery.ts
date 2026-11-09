import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { desktopRoute } from "./navigation";
import {
  bindNotificationSources,
  createHaltNotificationDelivery,
  createNotificationEpoch,
  type NotificationControl,
  requestNotificationPermission,
  sendWebNotification,
} from "./notification-delivery";
import { publicCatalogSchema } from "./project-create-api";
import {
  createProjectEventNotifications,
  NOTIFICATION_ACTIVITY_KINDS,
} from "./project-event-notifications";

/** One selected-project observer; stays active when hidden, using the window's shared stream. */
export function useNotificationDelivery(
  projectId: string | null,
  workspace: string | null,
  connected: boolean,
): NotificationControl {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState(
    "Window interruptions are off. Enable explicitly to request notification permission.",
  );
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const fence = useRef(createNotificationEpoch()).current;
  fence.adopt(JSON.stringify([projectId, workspace, connected, enabled]));
  const invalidate = () => {
    fence.invalidate();
    setSourceEpoch((value) => value + 1);
  };
  const generation = useRef(0),
    mounted = useRef(false);
  const latest = useRef({ projectId, workspace, connected, enabled });
  latest.current = { projectId, workspace, connected, enabled };
  useLayoutEffect(() => {
    const unbind = bindNotificationSources(
      {
        status: () => appStream().getState().status,
        onStatus: (listener) => appStream().subscribe(listener),
        onHash: (listener) => {
          window.addEventListener("hashchange", listener);
          return () => window.removeEventListener("hashchange", listener);
        },
      },
      invalidate,
    );
    return () => {
      fence.invalidate();
      unbind();
    };
  }, [fence]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fence.invalidate();
      generation.current++;
    };
  }, []);
  const pause = () => {
    generation.current++;
    invalidate();
    latest.current.enabled = false;
    setEnabled(false);
    setMessage(
      "Window interruptions paused. Activity and approval actions remain available.",
    );
  };
  const enable = async () => {
    const turn = ++generation.current;
    const permissionCurrent = fence.capture();
    if (typeof Notification === "undefined") {
      setMessage("Native notifications are unavailable in this runtime.");
      return;
    }
    try {
      const permission = await requestNotificationPermission(
        Notification,
        () =>
          mounted.current && turn === generation.current && permissionCurrent(),
      );
      if (
        !mounted.current ||
        turn !== generation.current ||
        !permissionCurrent()
      )
        return;
      if (permission !== "granted") {
        setMessage(
          "Notification permission was not granted. Window interruptions remain off.",
        );
        return;
      }
      setEnabled(true);
      setMessage(
        "Window interruptions enabled for the selected project. Only new supported events with a saved project opt-in notify.",
      );
    } catch {
      if (mounted.current && turn === generation.current && permissionCurrent())
        setMessage(
          "Notification permission is unavailable. Window interruptions remain off.",
        );
    }
  };
  useEffect(() => {
    if (!enabled || !connected || !projectId || !workspace) return;
    const owned = fence.capture();
    const current = () => {
      const next = latest.current;
      return (
        owned() &&
        mounted.current &&
        next.enabled &&
        next.connected &&
        appStream().getState().status === "live" &&
        next.projectId === projectId &&
        next.workspace === workspace &&
        desktopRoute(window.location.hash).projectId === projectId
      );
    };
    const status = (text: string) => {
      if (current()) setMessage(text);
    };
    const dependencies = {
      scope: { projectId, workspace },
      current,
      catalog: async () =>
        publicCatalogSchema.parse(
          await readOperatorRoute("/projects", {
            ...pageReads(),
            fetch: notificationRead,
          }),
        ),
      read: (path: string) =>
        readOperatorRoute(path, { ...pageReads(), fetch: notificationRead }),
      send: (notification: Parameters<typeof sendWebNotification>[0]) =>
        sendWebNotification(notification, status),
      navigate: (href: string) => {
        if (current()) window.location.hash = href;
      },
      status,
    };
    const delivery = createHaltNotificationDelivery(dependencies);
    const events = createProjectEventNotifications({
      ...dependencies,
      streamCursor: () => appStream().getState().cursor,
    });
    const refresh = (resync = false) => {
      void delivery.refresh(resync);
      void events.refresh(resync);
    };
    const unwatch = appStream().watch(
      ["shift.stopped", "operator.action", ...NOTIFICATION_ACTIVITY_KINDS],
      (reason) => {
        refresh(reason === "resync");
      },
    );
    const timer = window.setInterval(() => {
      refresh();
    }, 5000);
    refresh(true);
    return () => {
      unwatch();
      window.clearInterval(timer);
      delivery.dispose();
      events.dispose();
    };
  }, [enabled, connected, projectId, workspace, sourceEpoch, fence]);
  return { enabled, message, enable, pause };
}

/** Receive no more than 1 MiB, before JSON decoding or schema validation. */
export const createNotificationRead =
  (read: OperatorRead): OperatorRead =>
  (path, init) =>
    read(path, init, { maxBodyBytes: 1_048_576 });
export const notificationRead = createNotificationRead(operatorRead);

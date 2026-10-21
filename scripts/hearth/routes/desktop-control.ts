import type { ApiRoute, RouteReply } from "../api";
import { bodyFields } from "./operator-reads";

/** Mounted by the desktop host, so recovery survives the hearth it replaces. */
export function desktopControlRoutes(
  restart: () => Promise<RouteReply>,
): ApiRoute[] {
  return [
    {
      kind: "action",
      method: "POST",
      path: "/desktop/restart",
      action: "desktop.hearth.restart",
      validate: (request) => bodyFields(request, []),
      subject: () => ({}),
      effect: restart,
    },
  ];
}

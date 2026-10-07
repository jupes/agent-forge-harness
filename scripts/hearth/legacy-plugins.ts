/**
 * Transitional Vite wrappers that mount the moved route handlers in-process.
 * Replaced by `hearthPlugin` in the proxy checkpoint; kept so `bun run dashboard`
 * works at every commit in between.
 */
import type { Plugin } from "vite";
import { createCouncilService } from "../council/service";
import { loadDashboardServerEnvironment } from "../dashboard/server-environment";
import { councilHttpHandler } from "./routes/council";
import { devApiHttpHandler } from "./routes/dev-api";

export function devApiPlugin(root: string): Plugin {
  return {
    name: "agent-forge-dev-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void devApiHttpHandler(root, req, res, next);
      });
    },
  };
}

export function councilDashboardPlugin(
  root: string,
  environment?: Record<string, string | undefined>,
): Plugin {
  return {
    name: "agent-forge-council",
    configureServer(server) {
      const service = createCouncilService({
        workspaceRoot: root,
        harnessRoot: root,
        environment:
          environment ??
          loadDashboardServerEnvironment({ mode: "development", root }),
      });
      const handler = councilHttpHandler(service);
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next);
      });
      server.httpServer?.once("close", () => {
        void service.close();
      });
    },
  };
}

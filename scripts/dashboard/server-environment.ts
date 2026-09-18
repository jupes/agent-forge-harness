import { loadEnv } from "vite";

export type DashboardServerEnvironmentOptions = {
  mode: string;
  root: string;
  processEnvironment?: Record<string, string | undefined>;
};

/**
 * Load repository-local environment files for server-only dashboard services.
 * Values already present in the launching process take precedence.
 */
export function loadDashboardServerEnvironment({
  mode,
  root,
  processEnvironment = process.env,
}: DashboardServerEnvironmentOptions): Record<string, string | undefined> {
  return {
    ...loadEnv(mode, root, ""),
    ...processEnvironment,
  };
}

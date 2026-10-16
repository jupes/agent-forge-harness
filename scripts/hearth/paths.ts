export const API_PREFIX = "/__agent-forge";
export const TOKEN_ROUTE = `${API_PREFIX}/token`;
export const HEALTH_ROUTE = `${API_PREFIX}/health`;

/**
 * Mints a one-time launch secret (`POST`, with the operator token). Only a
 * holder of the token file can mint one: the dashboard's launcher, the open
 * command (`bun run dashboard:open`) and the browser suite's setup.
 */
export const LAUNCH_ROUTE = `${API_PREFIX}/launch`;

/**
 * Exchanges a launch secret for the dashboard's session cookie (`POST`,
 * same-origin, the secret in `LAUNCH_HEADER`). The token route then answers
 * only a request that carries that cookie.
 */
export const SESSION_ROUTE = `${API_PREFIX}/session`;

/** Carries the operator token on every mutating request. Lower case, as `node:http` reports it. */
export const OPERATOR_HEADER = "x-agent-forge-operator";

/** Which surface an action came through (`ui`, `cli`, `mcp`, `api`). A label the client declares, not a credential. */
export const SURFACE_HEADER = "x-agent-forge-surface";

/** Carries a launch secret to `SESSION_ROUTE`. Lower case, as `node:http` reports it. */
export const LAUNCH_HEADER = "x-agent-forge-launch";

/**
 * The key a launch link carries its secret under, in the URL's fragment:
 * `#launch=<secret>`, or `#/<route>?…&launch=<secret>` with a route. Never in
 * the query, so the secret reaches no server log and no `Referer`.
 */
export const LAUNCH_KEY = "launch";

/** The command that prints a fresh launch link for a running dashboard. */
export const OPEN_COMMAND = "bun run dashboard:open";

/**
 * What the token route answers a request without a valid dashboard session,
 * and what the page says when an action is not sent for that reason.
 */
export const NO_SESSION_ERROR = `This page has no dashboard session, or its session expired. Open the dashboard from its launcher: bun run dashboard (or ${OPEN_COMMAND} for a new link to a running one).`;

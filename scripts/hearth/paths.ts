export const API_PREFIX = "/__agent-forge";
export const TOKEN_ROUTE = `${API_PREFIX}/token`;
export const HEALTH_ROUTE = `${API_PREFIX}/health`;

/** Carries the operator token on every mutating request. Lower case, as `node:http` reports it. */
export const OPERATOR_HEADER = "x-agent-forge-operator";

/** Which surface an action came through (`ui`, `cli`, `mcp`, `api`). A label the client declares, not a credential. */
export const SURFACE_HEADER = "x-agent-forge-surface";

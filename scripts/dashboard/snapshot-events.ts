/**
 * What the dashboard dev server tells an open page over Vite's HMR socket.
 *
 * Imported by the dev server (`rebuild-pages.ts`, under Node) and bundled for
 * the browser (`docs/js/use-snapshot-rebuilt.ts`): constants only.
 */

/**
 * `docs/data/beads.json` was rebuilt. The page reads it again in place; it is
 * not reloaded, so what it holds that is not saved stays.
 */
export const SNAPSHOT_REBUILT_EVENT = "agent-forge:snapshot-rebuilt";

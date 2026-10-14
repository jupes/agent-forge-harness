/**
 * Read the snapshot again when the dev server says it was rebuilt.
 *
 * The dashboard dev server sends `SNAPSHOT_REBUILT_EVENT` over Vite's HMR
 * socket after a rebuild it started itself (its first build, a change under
 * `.beads/`, a tracker write the hearth made). It used to reload every open
 * page instead, which discarded what a page held that was not saved: a bead
 * half written in the builder, a comment being typed. A page that listens
 * here keeps all of that and only reads `data/beads.json` again.
 *
 * A static host has no HMR socket: there `import.meta.hot` is undefined, and
 * nothing listens.
 */

import { useEffect } from "preact/hooks";
import { SNAPSHOT_REBUILT_EVENT } from "../../scripts/dashboard/snapshot-events";
import type { BeadsPayload } from "../../types/beads";

/** Call `onRebuilt` each time the dev server says the snapshot was rebuilt. */
export function useSnapshotRebuilt(onRebuilt: () => void): void {
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return undefined;
    hot.on(SNAPSHOT_REBUILT_EVENT, onRebuilt);
    return () => hot.off(SNAPSHOT_REBUILT_EVENT, onRebuilt);
  }, [onRebuilt]);
}

/**
 * The snapshot as `url` answers it now, or null when it could not be read. A
 * read after a rebuild that fails keeps what the page already shows, rather
 * than replacing it with "No snapshot loaded".
 */
export async function readSnapshotAgain(
  url: string,
): Promise<BeadsPayload | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as BeadsPayload;
  } catch {
    return null;
  }
}

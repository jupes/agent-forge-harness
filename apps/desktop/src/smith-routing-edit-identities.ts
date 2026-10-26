import { canonicalSmithRoutingEditRequest } from "../../../scripts/config/smith-routing-edit-protocol";
import type { SmithRoutingEditRequest } from "../../../types/smith-routing-edit";

/** Browser-side digest; the private journal protocol stays Node-only. */
export async function smithRoutingEditInputHash(
  request: SmithRoutingEditRequest,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSmithRoutingEditRequest(request)),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

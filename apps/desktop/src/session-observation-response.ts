import {
  MAX_OBSERVATION_DETAIL_BYTES,
  MAX_OBSERVATION_INDEX_BYTES,
} from "../../../scripts/projects/session-observations-protocol";

/** Runs inside the existing readHearth whole-body deadline; accepts no partial envelope. */
export async function readSessionObservationResponse(
  response: Response,
  kind: "index" | "detail",
): Promise<unknown> {
  const limit =
    (kind === "index"
      ? MAX_OBSERVATION_INDEX_BYTES
      : MAX_OBSERVATION_DETAIL_BYTES) + 1024;
  const reader = response.body?.getReader();
  if (!reader)
    throw Error("The session metadata response has no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw Error(
          "The session metadata response exceeds this view's limit. Previously verified metadata is kept.",
        );
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error("The session metadata response is invalid.");
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error("The session metadata response is invalid.");
    }
    if (!raw || typeof raw !== "object" || !("ok" in raw))
      throw Error("The session metadata response is invalid.");
    if (raw.ok !== true || !response.ok)
      throw Error(
        "error" in raw &&
          typeof raw.error === "string" &&
          raw.error.length <= 2000
          ? raw.error
          : `Session metadata was refused (HTTP ${response.status}).`,
      );
    if (!("data" in raw) || !("error" in raw) || raw.error !== null)
      throw Error("The session metadata response is invalid.");
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

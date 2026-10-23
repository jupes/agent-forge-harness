import { MAX_ACTIVITY_PAGE_BYTES } from "../../../scripts/projects/activity-protocol";

/** Whole-body bounded decode, inside readHearth's existing abort/deadline boundary. */
export async function readProjectActivityResponse(
  response: Response,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Activity returned no complete metadata body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_ACTIVITY_PAGE_BYTES + 1024) {
        await reader.cancel();
        throw Error(
          "Activity metadata exceeds this read's limit. Earlier verified events are kept.",
        );
      }
      try {
        text += decoder.decode(part.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error("Activity returned invalid metadata.");
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error("Activity returned invalid metadata.");
    }
    if (!raw || typeof raw !== "object" || !("ok" in raw))
      throw Error("Activity returned invalid metadata.");
    if (raw.ok !== true || !response.ok)
      throw Error(
        "error" in raw &&
          typeof raw.error === "string" &&
          raw.error.length <= 2000
          ? raw.error
          : `Activity was refused (HTTP ${response.status}).`,
      );
    if (!("data" in raw) || !("error" in raw) || raw.error !== null)
      throw Error("Activity returned invalid metadata.");
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

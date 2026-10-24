import { MAX_PROJECT_RUN_BYTES } from "../../../scripts/projects/run-protocol";

/** Complete bounded UTF-8 envelope, inside the protected read's existing deadline. */
export async function readProjectRunsResponse(
  response: Response,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Run metadata returned no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_PROJECT_RUN_BYTES + 1024) {
        await reader.cancel();
        throw Error("Run metadata exceeds this read's receiving limit.");
      }
      try {
        text += decoder.decode(part.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error("Run metadata returned invalid text.");
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error("Run metadata returned invalid data.");
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 3 ||
      !("ok" in raw) ||
      !("data" in raw) ||
      !("error" in raw)
    )
      throw Error("Run metadata returned an incomplete answer.");
    if (!response.ok || raw.ok !== true)
      throw Error(
        typeof raw.error === "string" && raw.error.length <= 2000
          ? raw.error
          : `Run metadata was refused (HTTP ${response.status}).`,
      );
    if (raw.error !== null) throw Error("Run metadata could not be verified.");
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

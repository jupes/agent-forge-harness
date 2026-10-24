import { MAX_SMITHS_READ_BYTES } from "./smiths-protocol";

/** Complete bounded UTF-8 envelope, used inside the existing protected read deadline. */
export async function readSmithsResponse(
  response: Response,
  maxBytes = MAX_SMITHS_READ_BYTES,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("This read returned no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes + 1024) {
        await reader.cancel();
        throw Error(
          "This read exceeds its receiving limit. Earlier verified values are kept.",
        );
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error("This read returned invalid text.");
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error("This read returned invalid data.");
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
      throw Error("This read returned an incomplete answer.");
    if (!response.ok || raw.ok !== true)
      throw Error(
        typeof raw.error === "string" && raw.error.length <= 2000
          ? raw.error
          : `This read was refused (HTTP ${response.status}).`,
      );
    if (raw.error !== null) throw Error("This read could not be verified.");
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

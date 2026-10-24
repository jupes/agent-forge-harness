import { MAX_SESSION_EXPORT_BYTES } from "../../../scripts/sessions/library-protocol";

/** Called inside readHearth's existing whole-response deadline; never accepts a partial body. */
export async function readSessionExportResponse(
  response: Response,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw Error("The saved transcript response has no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // Fixed room for the API envelope; the export itself has its own 8 MiB check.
      if (bytes > MAX_SESSION_EXPORT_BYTES + 1024) {
        await reader.cancel();
        throw Error(
          "The complete transcript response exceeds its bounded export limit. No partial file was downloaded.",
        );
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error("The response is not a verified export.");
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error("The response is not a verified export.");
    }
    if (!raw || typeof raw !== "object" || !("ok" in raw))
      throw Error("The response is not a verified export.");
    if (raw.ok !== true || !response.ok) {
      const error =
        "error" in raw &&
        typeof raw.error === "string" &&
        raw.error.length <= 2000
          ? raw.error
          : `The export was refused (HTTP ${response.status}).`;
      throw Error(error);
    }
    if (!("data" in raw) || !("error" in raw) || raw.error !== null)
      throw Error("The response is not a verified export.");
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

/** A user-requested browser download; its exact bounded JSON is never kept in local storage. */
export async function downloadSessionTranscript(
  filename: string,
  text: string,
): Promise<void> {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    // Keep the Blob alive while the browser consumes it, with one export in flight.
    await new Promise<void>((done) => setTimeout(done, 1000));
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

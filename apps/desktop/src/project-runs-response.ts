import {
  MAX_PROJECT_RUN_ARTIFACT_RESPONSE_BYTES,
  MAX_PROJECT_RUN_BYTES,
} from "../../../scripts/projects/run-protocol";

/** Complete bounded UTF-8 envelope, inside the protected read's existing deadline. */
async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label: "Run metadata" | "Run artifact",
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error(`${label} returned no complete body.`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw Error(`${label} exceeds this read's receiving limit.`);
      }
      try {
        text += decoder.decode(part.value, { stream: true });
      } catch {
        await reader.cancel();
        throw Error(`${label} returned invalid text.`);
      }
    }
    let raw: unknown;
    try {
      text += decoder.decode();
      raw = JSON.parse(text);
    } catch {
      throw Error(`${label} returned invalid data.`);
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
      throw Error(`${label} returned an incomplete answer.`);
    if (!response.ok || raw.ok !== true)
      throw Error(
        typeof raw.error === "string" && raw.error.length <= 2000
          ? raw.error
          : `${label} was refused (HTTP ${response.status}).`,
      );
    if (raw.error !== null) throw Error(`${label} could not be verified.`);
    return raw.data;
  } finally {
    reader.releaseLock();
  }
}

export const readProjectRunsResponse = (response: Response) =>
  readBoundedResponse(response, MAX_PROJECT_RUN_BYTES + 1024, "Run metadata");

export const readProjectRunArtifactResponse = (response: Response) =>
  readBoundedResponse(
    response,
    MAX_PROJECT_RUN_ARTIFACT_RESPONSE_BYTES + 1024,
    "Run artifact",
  );

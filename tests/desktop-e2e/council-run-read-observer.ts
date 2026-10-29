import {
  type Page,
  type Request,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";

export type RunReadObservation =
  | { kind: "verified"; read: ProjectCouncilRunRead }
  | { kind: "interrupted"; reason: "aborted" | "body-unavailable" }
  | { kind: "invalid"; message: string };

export type RunReadObservations = Array<Promise<RunReadObservation>> & {
  dispose(): void;
};

export function responseData(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("error" in value) ||
    value.error !== null ||
    !("data" in value)
  )
    throw Error("The actual Council response envelope was not successful.");
  return value.data;
}

export function observeRunReads(page: Page, path: string): RunReadObservations {
  const origin = new URL(page.url()).origin;
  const failures = new Set<(request: Request) => void>();
  let disposed = false;
  let onResponse: ((response: PlaywrightResponse) => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (onResponse) page.off("response", onResponse);
    page.off("close", dispose);
    for (const listener of failures) page.off("requestfailed", listener);
    failures.clear();
  };
  const reads = Object.assign([] as Promise<RunReadObservation>[], { dispose });
  const handleResponse = (response: PlaywrightResponse) => {
    if (
      response.request().method() !== "GET" ||
      new URL(response.url()).origin !== origin ||
      new URL(response.url()).pathname !== path
    )
      return;
    if (!response.ok()) {
      reads.push(
        Promise.resolve({
          kind: "invalid",
          message: `Council result read returned HTTP ${response.status()}.`,
        }),
      );
      return;
    }
    const request = response.request();
    let onRequestFailed: ((failed: Request) => void) | undefined;
    const requestFailure = new Promise<RunReadObservation>((resolve) => {
      onRequestFailed = (failed) => {
        if (failed !== request) return;
        const errorText = failed.failure()?.errorText;
        resolve(
          errorText === "net::ERR_ABORTED"
            ? { kind: "interrupted", reason: "aborted" }
            : {
                kind: "invalid",
                message: errorText ?? "Council result request failed.",
              },
        );
      };
      failures.add(onRequestFailed);
      page.on("requestfailed", onRequestFailed);
    });
    const bodyRead = (async (): Promise<RunReadObservation> => {
      try {
        const raw = await response.json();
        return {
          kind: "verified",
          read: projectCouncilRunReadSchema.parse(responseData(raw)),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /^(?:response\.json: )?Protocol error \(Network\.getResponseBody\): No data found for (?:the )?resource with given identifier(?:\nResponse body is not available for a response that was navigated away from\. Read response\.body\(\) before triggering any navigation\.)?$/.test(
            message,
          )
        )
          return { kind: "interrupted", reason: "body-unavailable" };
        return { kind: "invalid", message };
      }
    })();
    reads.push(
      Promise.race([bodyRead, requestFailure]).finally(() => {
        if (onRequestFailed) {
          page.off("requestfailed", onRequestFailed);
          failures.delete(onRequestFailed);
        }
      }),
    );
  };
  onResponse = handleResponse;
  page.on("response", handleResponse);
  page.once("close", dispose);
  return reads;
}

export async function verifiedRunReads(
  observations: readonly Promise<RunReadObservation>[],
): Promise<ProjectCouncilRunRead[]> {
  const results = await Promise.all(observations);
  const invalid = results.find((result) => result.kind === "invalid");
  if (invalid?.kind === "invalid")
    throw Error(`The actual Council result read was invalid: ${invalid.message}`);
  return results.flatMap((result) =>
    result.kind === "verified" ? [result.read] : [],
  );
}

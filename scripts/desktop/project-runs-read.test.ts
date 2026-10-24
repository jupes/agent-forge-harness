import { expect, test } from "bun:test";
import { createProjectRunsReads } from "../../apps/desktop/src/project-runs-read";
import { createOperatorClient } from "../../docs/js/operator";
import { TOKEN_ROUTE } from "../hearth/paths";
import { MAX_PROJECT_RUN_BYTES } from "../projects/run-protocol";

test("actual Runs read wiring receives bounded protected metadata and never sends a write or a caller path", async () => {
  const calls: string[] = [];
  let overflow = false,
    cancelled = false;
  const client = createOperatorClient(async (url, init) => {
    if (url === TOKEN_ROUTE)
      return Response.json({
        ok: true,
        data: { token: "runs-token" },
        error: null,
      });
    calls.push(url);
    expect(init?.method).not.toBe("POST");
    expect(new Headers(init?.headers).get("x-agent-forge-operator")).toBe(
      "runs-token",
    );
    return overflow
      ? new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_PROJECT_RUN_BYTES + 1025));
            },
            cancel() {
              cancelled = true;
            },
          }),
        )
      : Response.json({ ok: true, data: { verified: true }, error: null });
  });
  const reads = createProjectRunsReads("project-alpha", {
    reader: client.read,
    options: { staticCopy: false },
  });
  expect(await reads.list(new AbortController().signal)).toEqual({
    verified: true,
  });
  overflow = true;
  await expect(
    reads.detail("alpha-run", new AbortController().signal),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(true);
  expect(calls).toEqual([
    "/__agent-forge/projects/project-alpha/runs",
    "/__agent-forge/projects/project-alpha/runs/alpha-run",
  ]);
});

test("strict read envelope rejects malformed UTF-8, unknown fields, empty success and protected refusal", async () => {
  let response = new Response(new Uint8Array([0xff]));
  const client = createOperatorClient(async (url) =>
    url === TOKEN_ROUTE
      ? Response.json({ ok: true, data: { token: "t" }, error: null })
      : response,
  );
  const reads = createProjectRunsReads("project-alpha", {
    reader: client.read,
    options: { staticCopy: false },
  });
  await expect(reads.list(new AbortController().signal)).rejects.toThrow(
    "invalid",
  );
  response = Response.json({ ok: true, data: null, error: null, extra: true });
  await expect(reads.list(new AbortController().signal)).rejects.toThrow(
    "incomplete",
  );
  response = Response.json(
    { ok: false, data: null, error: "Current membership unavailable" },
    { status: 503 },
  );
  await expect(reads.list(new AbortController().signal)).rejects.toThrow(
    "Current membership unavailable",
  );
});

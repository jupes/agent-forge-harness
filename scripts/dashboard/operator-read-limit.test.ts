import { expect, test } from "bun:test";
import { createOperatorClient } from "../../docs/js/operator";
import { TOKEN_ROUTE } from "../hearth/paths";

test("an opt-in protected read cancels overflowing reception without first buffering the complete body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  response.arrayBuffer = async () => {
    throw Error("Unbounded whole-body allocation happened first");
  };
  const client = createOperatorClient(async (url, init) => {
    if (url === TOKEN_ROUTE)
      return Response.json({
        ok: true,
        data: { token: "fixture-token" },
        error: null,
      });
    expect(new Headers(init?.headers).get("x-agent-forge-operator")).toBe(
      "fixture-token",
    );
    return response;
  });
  await expect(
    client.read("/bounded", {}, { maxBodyBytes: 4 }),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(true);
});

test("uncapped reads and successful event streams keep their existing body behavior", async () => {
  const live = new Response("data: fixture\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  live.arrayBuffer = async () => {
    throw Error("The live stream was buffered");
  };
  const client = createOperatorClient(async (url) =>
    url === TOKEN_ROUTE
      ? Response.json({ ok: true, data: { token: "t" }, error: null })
      : url === "/events"
        ? live
        : new Response("unchanged default", {
            status: 202,
            headers: { "x-fixture": "kept" },
          }),
  );
  const normal = await client.read("/normal");
  expect(normal.status).toBe(202);
  expect(normal.headers.get("x-fixture")).toBe("kept");
  expect(await normal.text()).toBe("unchanged default");
  expect(
    await client.read("/events", { headers: { accept: "text/event-stream" } }),
  ).toBe(live);
  await live.body?.cancel();
});

test("an exact receiving byte boundary preserves UTF-8, response status and headers", async () => {
  const client = createOperatorClient(async (url) =>
    url === TOKEN_ROUTE
      ? Response.json({ ok: true, data: { token: "t" }, error: null })
      : new Response("é", { status: 201, headers: { "x-bounded": "kept" } }),
  );
  const response = await client.read("/exact", {}, { maxBodyBytes: 2 });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-bounded")).toBe("kept");
  expect(await response.text()).toBe("é");
});

test("an aborted receiving-bounded read cancels its pending body and never waits for the rest", async () => {
  let arrived: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let cancelled = false;
  const client = createOperatorClient(async (url) => {
    if (url === TOKEN_ROUTE)
      return Response.json({ ok: true, data: { token: "t" }, error: null });
    arrived?.();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const control = new AbortController();
  const pending = client.read(
    "/held",
    { signal: control.signal },
    { maxBodyBytes: 32 },
  );
  await started;
  await Bun.sleep(0);
  control.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(cancelled).toBe(true);
});

test("the receiving cap survives the existing single pre-effect 403 retry", async () => {
  let tokens = 0,
    calls = 0,
    cancelled = false;
  const client = createOperatorClient(async (url) => {
    if (url === TOKEN_ROUTE)
      return Response.json({
        ok: true,
        data: { token: `t${++tokens}` },
        error: null,
      });
    if (++calls === 1) return new Response("no", { status: 403 });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  await expect(client.read("/retry", {}, { maxBodyBytes: 4 })).rejects.toThrow(
    "limit",
  );
  expect(tokens).toBe(2);
  expect(calls).toBe(2);
  expect(cancelled).toBe(true);
});

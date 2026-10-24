import { expect, test } from "bun:test";
import { MAX_SMITHS_READ_BYTES } from "../../apps/desktop/src/smiths-protocol";
import { createSmithsReads } from "../../apps/desktop/src/smiths-read";
import { createOperatorClient } from "../../docs/js/operator";
import { TOKEN_ROUTE } from "../hearth/paths";
import { MAX_SMITH_VERIFICATION_BYTES } from "../smith-verification";

test("the fixed verification read uses its own smaller receiving cap and no write request", async () => {
  let cancelled = false;
  const paths: string[] = [];
  const client = createOperatorClient(async (url, init) => {
    if (url === TOKEN_ROUTE)
      return Response.json({
        ok: true,
        data: { token: "verification-token" },
        error: null,
      });
    paths.push(url);
    expect(init?.method).not.toBe("POST");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(MAX_SMITH_VERIFICATION_BYTES + 1025),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const reads = createSmithsReads({
    reader: client.read,
    options: { staticCopy: false },
  });
  await expect(
    reads.verification(new AbortController().signal),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(true);
  expect(paths).toEqual(["/__agent-forge/smiths/verification"]);
});

test("the actual Smiths read wiring caps and cancels a protected response while receiving", async () => {
  let cancelled = false;
  const requests: string[] = [];
  const client = createOperatorClient(async (url, init) => {
    requests.push(url);
    if (url === TOKEN_ROUTE)
      return Response.json({
        ok: true,
        data: { token: "bounded-token" },
        error: null,
      });
    expect(init?.method).not.toBe("POST");
    expect(new Headers(init?.headers).get("x-agent-forge-operator")).toBe(
      "bounded-token",
    );
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SMITHS_READ_BYTES + 1025));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const reads = createSmithsReads({
    reader: client.read,
    options: { staticCopy: false },
  });
  await expect(
    reads.scoreboard(null, new AbortController().signal),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(true);
  expect(requests).toEqual([TOKEN_ROUTE, "/__agent-forge/scoreboard"]);
});

test("receiving-bounded Smiths wiring still rejects malformed bytes and envelopes and retains the exact range", async () => {
  const seen: string[] = [];
  let bytes = false;
  const client = createOperatorClient(async (url) => {
    if (url === TOKEN_ROUTE)
      return Response.json({ ok: true, data: { token: "t" }, error: null });
    seen.push(url);
    return bytes
      ? new Response(new Uint8Array([0xff]))
      : Response.json({ ok: true, error: null });
  });
  const reads = createSmithsReads({
    reader: client.read,
    options: { staticCopy: false },
  });
  const since = "2026-10-22T12:00:00.000Z";
  await expect(
    reads.scoreboard(since, new AbortController().signal),
  ).rejects.toThrow("incomplete");
  bytes = true;
  await expect(
    reads.scoreboard(since, new AbortController().signal),
  ).rejects.toThrow("invalid");
  expect(seen).toEqual(
    Array(2).fill(
      `/__agent-forge/scoreboard?since=${encodeURIComponent(since)}`,
    ),
  );
});

test("closing the actual Smiths protected read cancels a held response rather than accepting an empty success", async () => {
  let cancelled = false,
    arrived: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
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
  const reads = createSmithsReads({
    reader: client.read,
    options: { staticCopy: false },
  });
  const control = new AbortController();
  const pending = reads.scoreboard(null, control.signal);
  await started;
  await Bun.sleep(0);
  control.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(cancelled).toBe(true);
});

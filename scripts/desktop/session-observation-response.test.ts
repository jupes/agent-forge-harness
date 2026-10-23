import { expect, test } from "bun:test";
import { readSessionObservationResponse } from "../../apps/desktop/src/session-observation-response";
import { MAX_OBSERVATION_DETAIL_BYTES } from "../projects/session-observations-protocol";

test("a metadata response preserves specific refusal and cancels an oversized streamed body", async () => {
  expect(
    await readSessionObservationResponse(
      Response.json({ ok: true, data: { metadata: true }, error: null }),
      "detail",
    ),
  ).toEqual({ metadata: true });
  await expect(
    readSessionObservationResponse(
      Response.json(
        {
          ok: false,
          data: null,
          error: "Current project membership is unavailable",
        },
        { status: 503 },
      ),
      "detail",
    ),
  ).rejects.toThrow("Current project membership");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_OBSERVATION_DETAIL_BYTES + 2048));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readSessionObservationResponse(new Response(stream), "detail"),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(true);
  await expect(
    readSessionObservationResponse(
      new Response(new Uint8Array([255])),
      "detail",
    ),
  ).rejects.toThrow("invalid");
});

import { expect, test } from "bun:test";
import { readProjectActivityResponse } from "../../apps/desktop/src/project-activity-response";
import { MAX_ACTIVITY_PAGE_BYTES } from "../projects/activity-protocol";

test("Activity responses require a complete successful strict envelope and bounded valid UTF-8", async () => {
  expect(
    await readProjectActivityResponse(
      new Response(
        JSON.stringify({ ok: true, data: { fixture: true }, error: null }),
      ),
    ),
  ).toEqual({ fixture: true });
  for (const value of [
    "<html>not metadata</html>",
    JSON.stringify({ ok: true, data: {}, error: "not successful" }),
    JSON.stringify({ ok: true, error: null }),
  ])
    await expect(
      readProjectActivityResponse(new Response(value)),
    ).rejects.toThrow();
  await expect(
    readProjectActivityResponse(new Response(new Uint8Array([0xff]))),
  ).rejects.toThrow("invalid");
  await expect(
    readProjectActivityResponse(
      new Response(
        JSON.stringify({
          ok: false,
          data: null,
          error: "Fixture membership unavailable",
        }),
        { status: 503 },
      ),
    ),
  ).rejects.toThrow("Fixture membership unavailable");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_ACTIVITY_PAGE_BYTES + 2048));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readProjectActivityResponse(new Response(body))).rejects.toThrow(
    "limit",
  );
  expect(cancelled).toBe(true);
});

import { expect, test } from "bun:test";
import { readSessionExportResponse } from "../../apps/desktop/src/session-export";
import { MAX_SESSION_EXPORT_BYTES } from "../sessions/library-protocol";

test("the complete export reader preserves an envelope and refuses a streaming body beyond its fixed bound", async () => {
  expect(
    await readSessionExportResponse(
      Response.json({
        ok: true,
        data: { text: "Private 🌱 value" },
        error: null,
      }),
    ),
  ).toEqual({ text: "Private 🌱 value" });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_SESSION_EXPORT_BYTES + 2048));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readSessionExportResponse(new Response(body))).rejects.toThrow(
    "exceeds",
  );
  expect(cancelled).toBe(true);
});

test("an export read keeps a specific server refusal and rejects malformed or invalid UTF-8 replies", async () => {
  await expect(
    readSessionExportResponse(
      Response.json(
        {
          ok: false,
          data: null,
          error: "The complete transcript exceeds its limit.",
        },
        { status: 503 },
      ),
    ),
  ).rejects.toThrow("exceeds its limit");
  await expect(
    readSessionExportResponse(new Response("<html>not an export")),
  ).rejects.toThrow("not a verified export");
  await expect(
    readSessionExportResponse(new Response(new Uint8Array([0xff, 0xfe]))),
  ).rejects.toThrow("not a verified export");
});

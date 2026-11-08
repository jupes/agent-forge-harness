import { expect, test } from "bun:test";
import { createCleanupTransport } from "../../apps/desktop/src/use-project-worktree-cleanup";
import { createOperatorClient } from "../../docs/js/operator";
import { API_PREFIX, OPERATOR_HEADER, TOKEN_ROUTE } from "../hearth/paths";

const limits = { maxBodyBytes: 65536 };
const envelope = (data: unknown) =>
  Response.json({ ok: true, data, error: null });
function transport(
  answer: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return createCleanupTransport(
    createOperatorClient(
      (url, init) =>
        url === TOKEN_ROUTE
          ? Promise.resolve(envelope({ token: "held" }))
          : answer(url, init),
      { sessionKeys: { get: () => null, set: () => undefined } },
    ),
  );
}

test("cleanup transport captures protected adapters, prefixes routes and preserves health spelling/version", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const health = { root: "C:\\Work\\Ä", pid: 7, apiVersion: 999 };
  const client = transport(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/review")) {
      const body = JSON.stringify({
        ok: true,
        data: { value: "exact" },
        error: null,
      });
      return new Response(body.padEnd(65536, " "));
    }
    return envelope(url.endsWith("/health") ? health : { value: "exact" });
  });
  expect(await client.health()).toEqual(health);
  expect(await client.readReview("/review", limits)).toEqual({
    value: "exact",
  });
  expect(await client.readReceipt("/receipt", limits)).toEqual({
    value: "exact",
  });
  const post = await client.operatorPost(
    "/cleanup",
    { original: true },
    limits,
  );
  expect(await post.json()).toEqual({
    ok: true,
    data: { value: "exact" },
    error: null,
  });
  expect(calls.map((call) => call.url)).toEqual(
    ["/health", "/review", "/receipt", "/cleanup"].map(
      (route) => API_PREFIX + route,
    ),
  );
  expect(
    calls.every(
      (call) => new Headers(call.init?.headers).get(OPERATOR_HEADER) === "held",
    ),
  ).toBe(true);
  expect(calls.at(-1)?.init?.method).toBe("POST");
  expect(calls.at(-1)?.init?.body).toBe('{"original":true}');
});

for (const method of ["readReview", "readReceipt", "operatorPost"] as const) {
  test(
    method +
      " cancels 65537 bytes at the real receiving boundary before whole-body decode",
    async () => {
      let cancelled = 0,
        decoded = 0;
      const client = transport(async () => {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(32768));
              controller.enqueue(new Uint8Array(32768));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled++;
            },
          }),
        );
        response.text = async () => {
          decoded++;
          return "";
        };
        response.json = async () => {
          decoded++;
          return null;
        };
        response.arrayBuffer = async () => {
          decoded++;
          return new ArrayBuffer(0);
        };
        return response;
      });
      const request =
        method === "operatorPost"
          ? client.operatorPost("/cleanup", {}, limits)
          : client[method]("/cleanup", limits);
      await expect(request).rejects.toThrow("exceeds its byte limit");
      expect(cancelled).toBe(1);
      expect(decoded).toBe(0);
    },
  );
}

test("cleanup reads reject HTTP failure, nonstrict envelopes, malformed and decoded duplicate JSON", async () => {
  const bodies = [
    '{"ok":false,"data":{},"error":null}',
    '{"ok":true,"data":{}}',
    '{"ok":true,"error":null}',
    '{"ok":true,"data":{},"error":null,"extra":1}',
    '{"ok":true,"data":{},"error":"bad"}',
    "null",
    "{",
    String.raw`{"ok":true,"data":{"x":1,"\u0078":2},"error":null}`,
    String.raw`{"ok":false,"\u006fk":true,"data":{},"error":null}`,
  ];
  for (const raw of bodies) {
    const client = transport(async () => new Response(raw));
    await expect(client.readReview("/review", limits)).rejects.toThrow(
      "could not be verified",
    );
  }
  const refused = transport(async () => new Response("{}", { status: 503 }));
  await expect(refused.readReceipt("/receipt", limits)).rejects.toThrow(
    "was refused",
  );
});

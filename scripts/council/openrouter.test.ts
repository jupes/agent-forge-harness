import { expect, test } from "bun:test";
import { loadCouncilProfile } from "./cli";
import { buildContextPack } from "./context";
import { createProviderResolver, providerReadiness } from "./providers";
import {
  type ModelRequest,
  ModelTransportError,
  parseCouncilProfileJson,
} from "./types";

const profile = () =>
  loadCouncilProfile(
    `${import.meta.dir}/../../councils/openrouter.example.json`,
  );
const environment = {
  OPENROUTER_API_KEY: "not-a-standard-key.router-test.123456789",
};
const output = { verdict: "pass", findings: [], strengths: [], unknowns: [] };
function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-123",
    model: "openai/served-snapshot",
    provider: "OpenAI",
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(output) } },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.02 },
    openrouter_metadata: { is_byok: false },
    ...overrides,
  };
}
function request(stage: ModelRequest["stage"] = "independent"): ModelRequest {
  return {
    runId: "gateway-contract",
    stage,
    seat: profile().seats[0]!,
    system: "Return JSON",
    prompt: "Review",
    context: buildContextPack({ kind: "stdin", text: "Review" }),
  };
}
function resolver(body: Record<string, unknown>) {
  return createProviderResolver({
    environment,
    fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
  });
}

for (const stage of ["independent", "peer", "revision", "chair"] as const) {
  test(`OpenRouter ${stage} requires the structured contract and explicit privacy policy`, async () => {
    const req = request(stage);
    const transport = createProviderResolver({
      environment,
      fetchImpl: (async (url, init) => {
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${environment.OPENROUTER_API_KEY}`,
        );
        expect(init?.redirect).toBe("error");
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(String(init?.body));
        } catch {
          throw new Error("Invalid test body");
        }
        expect(body.provider).toEqual({
          require_parameters: true,
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
        });
        expect(body.response_format).toMatchObject({
          type: "json_schema",
          json_schema: { name: `council_${stage}`, strict: true },
        });
        expect(body.models).toBeUndefined();
        expect(body.transforms).toEqual([]);
        expect(body.max_tokens).toBe(req.seat.maxOutputTokens);
        return Response.json(response());
      }) as typeof fetch,
    })(req.seat);
    const result = await transport.generate(req, new AbortController().signal);
    expect(result.costUsd).toBe(0.02);
    expect(result.routing).toMatchObject({
      responseId: "gen-123",
      provider: "OpenAI",
      model: "openai/served-snapshot",
      byok: false,
    });
  });
}

test("one gateway key satisfies all four vendors and routing choices survive profile parsing", () => {
  const selected = profile();
  expect(providerReadiness(selected, {})).toMatchObject([
    { configured: false, missing: ["OPENROUTER_API_KEY"] },
  ]);
  selected.seats[0]!.openRouter = {
    only: ["openai"],
    allowFallbacks: true,
    dataCollection: "allow",
    zeroDataRetention: false,
  };
  const parsed = parseCouncilProfileJson(JSON.stringify(selected));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  const readiness = providerReadiness(parsed.value, environment);
  expect(readiness).toHaveLength(1);
  expect(readiness[0]).toMatchObject({
    configured: true,
    outputFormat: "json-schema",
    validation: "local-configuration-only",
  });
  expect(readiness[0]?.routing?.[0]).toEqual({
    seatId: "correctness",
    require_parameters: true,
    only: ["openai"],
    allow_fallbacks: true,
    data_collection: "allow",
    zdr: false,
  });
  expect(JSON.stringify(readiness)).not.toContain(
    environment.OPENROUTER_API_KEY,
  );
});

test("invalid routing and auto/tool model aliases fail before calls", () => {
  for (const routing of [
    { zeroDataRetention: "false" },
    { only: [] },
    { only: ["vendor bad"] },
    { dataCollection: "no" },
    { require_parameters: false },
  ]) {
    const selected = profile();
    Object.assign(selected.seats[0]!, { openRouter: routing });
    expect(parseCouncilProfileJson(JSON.stringify(selected)).ok).toBe(false);
  }
  for (const model of [
    "openrouter/auto",
    "openai/gpt-5.4:online",
    "not-a-slug",
  ]) {
    const selected = profile();
    selected.seats[0]!.model = model;
    expect(parseCouncilProfileJson(JSON.stringify(selected)).ok).toBe(false);
  }
  const selected = profile();
  selected.seats[0]!.provider = "openai";
  expect(parseCouncilProfileJson(JSON.stringify(selected)).ok).toBe(false);
});

test("gateway error accounting survives JSON failure and routing metadata is scrubbed", async () => {
  const req = request();
  const body = response({
    provider: environment.OPENROUTER_API_KEY,
    choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
  });
  try {
    await resolver(body)(req.seat).generate(req, new AbortController().signal);
    throw new Error("Expected malformed response failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelTransportError);
    const failure = error as ModelTransportError;
    expect(failure.costUsd).toBe(0.02);
    expect(failure.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(JSON.stringify(failure.routing)).not.toContain(
      environment.OPENROUTER_API_KEY,
    );
  }
});

test("gateway billing includes known BYOK charges but never treats an unknown bill as zero", async () => {
  const req = request();
  for (const [upstream, total] of [
    [0.5, 0.52],
    [null, undefined],
  ] as const) {
    const result = await resolver(
      response({
        openrouter_metadata: { is_byok: true },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cost: 0.02,
          cost_details: { upstream_inference_cost: upstream },
        },
      }),
    )(req.seat).generate(req, new AbortController().signal);
    expect(result.costUsd).toBe(total);
    expect(result.routing?.byok).toBe(true);
  }
  const result = await resolver(
    response({ usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } }),
  )(req.seat).generate(req, new AbortController().signal);
  expect(result.costUsd).toBe(0);
  await expect(
    resolver(
      response({
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: -1 },
      }),
    )(req.seat).generate(req, new AbortController().signal),
  ).rejects.toThrow("invalid cost");
});

test("unsupported gateway routes fail without retry or credential exposure", async () => {
  let calls = 0;
  const req = request();
  const transport = createProviderResolver({
    environment,
    fetchImpl: (async () => {
      calls++;
      return Response.json(
        {
          error: {
            message: `No matching endpoints ${environment.OPENROUTER_API_KEY}`,
          },
        },
        { status: 404 },
      );
    }) as unknown as typeof fetch,
  })(req.seat);
  try {
    await transport.generate(req, new AbortController().signal);
    throw new Error("Expected no route");
  } catch (error) {
    expect(String(error)).toContain("No matching endpoints");
    expect(String(error)).not.toContain(environment.OPENROUTER_API_KEY);
  }
  expect(calls).toBe(1);
});

import { describe, expect, test } from "bun:test";
import { buildContextPack } from "./context";
import { createProviderResolver, providerReadiness } from "./providers";
import {
  type CouncilProfile,
  type CouncilSeat,
  type CouncilStage,
  type ModelRequest,
  ModelTransportError,
} from "./types";

const providers = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
  "openrouter",
] as const;
type Provider = (typeof providers)[number];
const environment = {
  OPENAI_API_KEY: "unusual.openai.credential.123456789",
  ANTHROPIC_API_KEY: "unusual.anthropic.credential.123456789",
  DEEPSEEK_API_KEY: "unusual.deepseek.credential.123456789",
  DASHSCOPE_API_KEY: "unusual.qwen.credential.123456789",
  OPENROUTER_API_KEY: "unusual.router.credential.123456789",
};
const output = { verdict: "pass", findings: [], strengths: [], unknowns: [] };

function seat(provider: Provider): CouncilSeat {
  return {
    id: provider,
    provider,
    model: provider === "openrouter" ? "openai/contract-test" : "contract-test",
    role: "Reviewer",
    timeoutMs: 1000,
    maxOutputTokens: 2000,
    estimatedCostUsd: 0.1,
    tokenRatesUsdPerMillion: { input: 2, output: 3 },
  };
}

function request(
  provider: Provider,
  stage: CouncilStage = "independent",
): ModelRequest {
  return {
    runId: "provider-contract",
    stage,
    seat: seat(provider),
    system: "Return the required JSON.",
    prompt: "Review this note.",
    context: buildContextPack({ kind: "stdin", text: "A review note." }),
  };
}

function responseBody(
  provider: Provider,
  text = JSON.stringify(output),
): Record<string, unknown> {
  if (provider === "openai")
    return {
      status: "completed",
      output: [{ content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    };
  if (provider === "anthropic")
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    };
  return {
    choices: [{ finish_reason: "stop", message: { content: text } }],
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
  };
}

function transport(provider: Provider, body: Record<string, unknown>) {
  return createProviderResolver({
    environment,
    fetchImpl: (async () =>
      new Response(JSON.stringify(body))) as unknown as typeof fetch,
  })(seat(provider));
}

async function failure(
  provider: Provider,
  body: Record<string, unknown>,
): Promise<ModelTransportError> {
  try {
    await transport(provider, body).generate(
      request(provider),
      new AbortController().signal,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(ModelTransportError);
    return error as ModelTransportError;
  }
  throw new Error("Expected the provider response to fail");
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  try {
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  } catch {
    throw new Error("Expected a JSON request body");
  }
}

describe("provider request contracts", () => {
  // These are wire-contract tests, not live service smoke tests. In particular,
  // Anthropic documents that raw numerical schema limits return HTTP 400:
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  for (const stage of ["independent", "peer", "revision", "chair"] as const) {
    test(`transforms Anthropic's ${stage} schema without weakening OpenAI's schema`, async () => {
      const bodies = new Map<string, Record<string, unknown>>();
      for (const provider of ["anthropic", "openai"] as const) {
        const resolver = createProviderResolver({
          environment,
          fetchImpl: (async (_url, init) => {
            bodies.set(provider, parseBody(init));
            expect(init?.redirect).toBe("error");
            return new Response(JSON.stringify(responseBody(provider)));
          }) as typeof fetch,
        });
        await resolver(seat(provider)).generate(
          request(provider, stage),
          new AbortController().signal,
        );
      }
      const anthropic = bodies.get("anthropic")!;
      const openai = bodies.get("openai")!;
      const anthropicWire = JSON.stringify(anthropic.output_config);
      expect(anthropicWire).not.toContain('"minimum"');
      expect(anthropicWire).not.toContain('"maximum"');
      expect(anthropicWire).toContain('"additionalProperties":false');
      if (stage !== "chair") {
        expect(anthropicWire).toContain(
          "Must be at least 0. Must be at most 1.",
        );
        expect(JSON.stringify(openai.text)).toContain('"minimum":0');
      }
      expect(openai.store).toBe(false);
      expect(openai.max_output_tokens).toBe(2000);
      expect(anthropic.max_tokens).toBe(2000);
    });
  }

  for (const provider of ["deepseek", "qwen"] as const) {
    test(`${provider} requests JSON mode and includes the output contract`, async () => {
      const resolver = createProviderResolver({
        environment,
        fetchImpl: (async (_url, init) => {
          const body = parseBody(init);
          expect(body.response_format).toEqual({ type: "json_object" });
          expect(body.stream).toBe(false);
          expect(JSON.stringify(body.messages)).toContain("JSON");
          return new Response(JSON.stringify(responseBody(provider)));
        }) as typeof fetch,
      });
      await resolver(seat(provider)).generate(
        request(provider),
        new AbortController().signal,
      );
    });
  }

  test("readiness validates local endpoints without claiming live model or key validation", () => {
    const profile: CouncilProfile = {
      schemaVersion: 1,
      id: "test",
      title: "Test",
      depth: "balanced",
      minQuorum: 2,
      minPeerBallots: 1,
      maxEstimatedUsd: 1,
      seats: [seat("openai"), seat("qwen")],
      chair: { ...seat("openai"), id: "chair" },
    };
    const results = providerReadiness(profile, {
      ...environment,
      OPENAI_BASE_URL: "https://user:secret@provider.example/v1",
    });
    expect(
      results.find((entry) => entry.provider === "openai")?.configured,
    ).toBe(false);
    expect(
      results.find((entry) => entry.provider === "openai")?.error,
    ).toContain("cannot contain credentials");
    expect(results.find((entry) => entry.provider === "qwen")?.configured).toBe(
      true,
    );
    expect(
      results.every((entry) => entry.validation === "local-configuration-only"),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("user:secret");
  });
});

describe("provider completion and accounting contracts", () => {
  for (const provider of providers) {
    test(`${provider} distinguishes usage estimates from unreported actual billing`, async () => {
      const result = await transport(provider, responseBody(provider)).generate(
        request(provider),
        new AbortController().signal,
      );
      expect(result.usage).toEqual({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
      expect(result.estimatedUsageCostUsd).toBe(3.5);
      expect(result.costUsd).toBeUndefined();
      expect(result.output).toEqual(output);
    });

    test(`${provider} preserves billed usage after malformed JSON`, async () => {
      const error = await failure(
        provider,
        responseBody(provider, '{"verdict":'),
      );
      expect(error.message).toBe("provider returned invalid JSON");
      expect(error.usage).toEqual({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
      expect(error.estimatedUsageCostUsd).toBe(3.5);
    });

    test(`${provider} rejects truncated responses even when the text happens to be valid JSON`, async () => {
      const body = responseBody(provider);
      if (provider === "openai") {
        body.status = "incomplete";
        body.incomplete_details = { reason: "max_output_tokens" };
      } else if (provider === "anthropic") body.stop_reason = "max_tokens";
      else
        body.choices = [
          {
            finish_reason: "length",
            message: { content: JSON.stringify(output) },
          },
        ];
      const error = await failure(provider, body);
      expect(error.message).toContain("did not complete");
      expect(error.usage?.outputTokens).toBe(500_000);
      expect(error.estimatedUsageCostUsd).toBe(3.5);
    });

    test(`${provider} rejects explicit refusals`, async () => {
      const body = responseBody(provider);
      if (provider === "openai")
        body.output = [
          { content: [{ type: "refusal", refusal: "Cannot review." }] },
        ];
      else if (provider === "anthropic") body.stop_reason = "refusal";
      else
        body.choices = [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(output),
              refusal: "Cannot review.",
            },
          },
        ];
      const error = await failure(provider, body);
      expect(error.usage?.inputTokens).toBe(1_000_000);
    });

    test(`${provider} redacts exact configured secrets from successful outputs`, async () => {
      const text = JSON.stringify({
        ...output,
        strengths: Object.values(environment),
      });
      const result = await transport(
        provider,
        responseBody(provider, text),
      ).generate(request(provider), new AbortController().signal);
      const serialized = JSON.stringify(result);
      for (const secret of Object.values(environment))
        expect(serialized).not.toContain(secret);
      expect(serialized).toContain("[REDACTED:provider-api-key]");
    });
  }

  test("includes Anthropic cached input tokens in usage estimates", async () => {
    const body = responseBody("anthropic");
    body.usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 70,
    };
    const result = await transport("anthropic", body).generate(
      request("anthropic"),
      new AbortController().signal,
    );
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 20 });
    expect(result.estimatedUsageCostUsd).toBe(0.0005);
  });

  test("does not invent prices when the profile omits token rates", async () => {
    const req = request("openai");
    delete req.seat.tokenRatesUsdPerMillion;
    const result = await transport("openai", responseBody("openai")).generate(
      req,
      new AbortController().signal,
    );
    expect(result.estimatedUsageCostUsd).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });
});

describe("provider error redaction", () => {
  test("redacts before truncation and whitespace normalization", async () => {
    const key = environment.OPENAI_API_KEY;
    const resolver = createProviderResolver({
      environment,
      fetchImpl: (async () =>
        new Response(" ".repeat(1490) + key, {
          status: 401,
        })) as unknown as typeof fetch,
    });
    try {
      await resolver(seat("openai")).generate(
        request("openai"),
        new AbortController().signal,
      );
      throw new Error("Expected HTTP error");
    } catch (error) {
      expect(String(error)).toContain("provider HTTP 401");
      expect(String(error)).toContain("[REDACTED:provider-api-key]");
      expect(String(error)).not.toContain(key.slice(0, 10));
    }
  });

  test("scrubs exact keys in network failures, including other configured providers", async () => {
    const resolver = createProviderResolver({
      environment,
      fetchImpl: (async () => {
        throw new Error(Object.values(environment).join(" "));
      }) as unknown as typeof fetch,
    });
    try {
      await resolver(seat("openai")).generate(
        request("openai"),
        new AbortController().signal,
      );
      throw new Error("Expected network error");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelTransportError);
      for (const secret of Object.values(environment))
        expect(String(error)).not.toContain(secret);
    }
  });
});

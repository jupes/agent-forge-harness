import { describe, expect, test } from "bun:test";
import { buildContextPack } from "./context";
import {
  type CouncilProviderEndpoint,
  createProviderResolver,
  providerEndpointSnapshot,
} from "./providers";
import type { CouncilProfile, CouncilSeat } from "./types";

function seat(provider: string, id = provider): CouncilSeat {
  return {
    id,
    provider,
    model: "endpoint-test",
    role: "Reviewer",
    timeoutMs: 1_000,
    maxOutputTokens: 200,
    estimatedCostUsd: 0,
  };
}

function profile(): CouncilProfile {
  return {
    schemaVersion: 1,
    id: "endpoint-test",
    title: "Endpoint test",
    depth: "balanced",
    minQuorum: 2,
    minPeerBallots: 1,
    maxEstimatedUsd: 1,
    seats: [seat("openai"), seat("fake"), seat("openai", "second")],
    chair: seat("anthropic", "chair"),
  };
}

function resolverWithUntrustedSnapshot(snapshot: unknown) {
  return createProviderResolver({
    endpoints: snapshot as readonly CouncilProviderEndpoint[],
    environment: { OPENAI_API_KEY: "credential-current" },
  });
}

describe("Council provider endpoint snapshots", () => {
  test("captures sorted unique used providers and only normalized endpoint data", () => {
    const snapshot = providerEndpointSnapshot(profile(), {
      OPENAI_BASE_URL: "https://review.example/v1/",
      ANTHROPIC_BASE_URL: "http://localhost:8080/anthropic/",
      OPENAI_API_KEY: "must-not-be-captured",
    });
    expect(snapshot).toEqual([
      {
        provider: "anthropic",
        transport: "anthropic",
        baseUrl: "http://localhost:8080/anthropic",
      },
      { provider: "fake", transport: "fake", baseUrl: null },
      {
        provider: "openai",
        transport: "openai-responses",
        baseUrl: "https://review.example/v1",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-be-captured");
    expect(JSON.stringify(snapshot)).not.toContain("API_KEY");
  });

  test("rejects unknown profile providers and unsafe configured URLs", () => {
    const unknown = profile();
    unknown.seats[0] = seat("unsupported-provider");
    expect(() => providerEndpointSnapshot(unknown)).toThrow(
      "unsupported council provider",
    );
    for (const unsafe of [
      "https://user:password@review.example/v1",
      "https://review.example/v1?token=secret",
      "https://review.example/v1#fragment",
      "http://review.example/v1",
    ]) {
      expect(() =>
        providerEndpointSnapshot(profile(), { OPENAI_BASE_URL: unsafe }),
      ).toThrow();
    }
  });

  test("rejects malformed supplied snapshots and missing used providers", () => {
    const valid: CouncilProviderEndpoint[] = [
      {
        provider: "openai",
        transport: "openai-responses",
        baseUrl: "https://a.example/v1",
      },
    ];
    const invalidSnapshots: unknown[] = [
      [...valid, ...valid],
      [
        {
          provider: "unknown",
          transport: "openai-responses",
          baseUrl: "https://a.example",
        },
      ],
      [
        {
          provider: "openai",
          transport: "openai-chat",
          baseUrl: "https://a.example",
        },
      ],
      [
        {
          provider: "openai",
          transport: "openai-responses",
          baseUrl: "https://a.example/",
        },
      ],
      [
        {
          provider: "openai",
          transport: "openai-responses",
          baseUrl: "https://user:secret@a.example",
        },
      ],
      [
        {
          provider: "openai",
          transport: "openai-responses",
          baseUrl: "https://a.example",
          apiKey: "private",
        },
      ],
      [
        {
          provider: "openai",
          transport: "openai-responses",
          baseUrl: `https://${"a".repeat(4_100)}.example`,
        },
      ],
      Array.from({ length: 7 }, (_, index) => ({
        provider: "openai",
        transport: "openai-responses",
        baseUrl: `https://${index}.example`,
      })),
    ];
    for (const invalid of invalidSnapshots) {
      expect(() => resolverWithUntrustedSnapshot(invalid)).toThrow();
    }
    const resolver = createProviderResolver({
      endpoints: valid,
      environment: { OPENAI_API_KEY: "credential-current" },
    });
    expect(() => resolver(seat("anthropic"))).toThrow("snapshot is missing");
  });

  test("uses the captured URL and the current credential after environment rotation", async () => {
    const environment: Record<string, string | undefined> = {
      OPENAI_BASE_URL: "https://endpoint-a.example/v1",
      OPENAI_API_KEY: "credential-before-capture",
    };
    const endpoints = providerEndpointSnapshot(profile(), environment);
    const originalOpenAiEndpoint = endpoints.find(
      (endpoint) => endpoint.provider === "openai",
    )!;
    const observed: Array<{ url: string; key: string | null }> = [];
    const resolver = createProviderResolver({
      endpoints,
      environment,
      fetchImpl: (async (input, init) => {
        observed.push({
          url: String(input),
          key: new Headers(init?.headers).get("authorization"),
        });
        return new Response("current-credential-rotated", { status: 401 });
      }) as typeof fetch,
    });
    endpoints.reverse();
    originalOpenAiEndpoint.baseUrl = "https://endpoint-b.example/v1";
    environment.OPENAI_BASE_URL = "https://endpoint-b.example/v1";
    environment.OPENAI_API_KEY = "current-credential-rotated";

    let dispatchError = "";
    try {
      await resolver(seat("openai")).generate(
        {
          runId: "endpoint-test",
          stage: "independent",
          seat: seat("openai"),
          system: "Review.",
          prompt: "Review.",
          context: buildContextPack({ kind: "stdin", text: "Review." }),
        },
        new AbortController().signal,
      );
    } catch (error) {
      dispatchError = String(error);
    }
    expect(observed).toEqual([
      {
        url: "https://endpoint-a.example/v1/responses",
        key: "Bearer current-credential-rotated",
      },
    ]);
    expect(dispatchError).toContain("provider HTTP 401");
    expect(dispatchError).not.toContain("current-credential-rotated");
  });
});

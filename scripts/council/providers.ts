import { sanitizeContent } from "./context";
import { FakeCouncilTransport } from "./engine";
import type {
  CouncilProfile,
  CouncilSeat,
  CouncilStage,
  ModelResult,
  ModelTransport,
  ModelUsage,
} from "./types";

type JsonSchema = Record<string, unknown>;
type FetchLike = typeof fetch;
type Environment = Record<string, string | undefined>;

const SEVERITY_SCHEMA = {
  type: "string",
  enum: ["blocker", "high", "medium", "low"],
} as const;

const FINDING_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    localId: { type: "string" },
    title: { type: "string" },
    severity: SEVERITY_SCHEMA,
    claim: { type: "string" },
    consequence: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "localId",
    "title",
    "severity",
    "claim",
    "consequence",
    "evidenceIds",
    "confidence",
  ],
};

const OUTPUT_SCHEMAS: Record<CouncilStage, JsonSchema> = {
  independent: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "needs_changes", "uncertain"],
      },
      findings: { type: "array", items: FINDING_SCHEMA },
      strengths: { type: "array", items: { type: "string" } },
      unknowns: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "findings", "strengths", "unknowns"],
  },
  peer: {
    type: "object",
    additionalProperties: false,
    properties: {
      ballots: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            candidateId: { type: "string" },
            stance: {
              type: "string",
              enum: ["support", "oppose", "uncertain"],
            },
            reason: { type: "string" },
            evidenceIds: { type: "array", items: { type: "string" } },
            suggestedSeverity: {
              anyOf: [SEVERITY_SCHEMA, { type: "null" }],
            },
          },
          required: [
            "candidateId",
            "stance",
            "reason",
            "evidenceIds",
            "suggestedSeverity",
          ],
        },
      },
      missingFindings: { type: "array", items: FINDING_SCHEMA },
    },
    required: ["ballots", "missingFindings"],
  },
  chair: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "needs_changes", "insufficient_evidence"],
      },
      summary: { type: "string" },
      recommendations: { type: "array", items: { type: "string" } },
      consensusFindingKeys: { type: "array", items: { type: "string" } },
      dissentFindingKeys: { type: "array", items: { type: "string" } },
    },
    required: [
      "verdict",
      "summary",
      "recommendations",
      "consensusFindingKeys",
      "dissentFindingKeys",
    ],
  },
};

type ProviderId = "anthropic" | "deepseek" | "fake" | "openai" | "qwen";

type ProviderConfig = {
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  apiStyle: "anthropic" | "fake" | "openai-chat" | "openai-responses";
};

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  fake: { apiStyle: "fake" },
  openai: {
    apiStyle: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    apiStyle: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  deepseek: {
    apiStyle: "openai-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  qwen: {
    apiStyle: "openai-chat",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
};

export type ProviderReadiness = {
  provider: string;
  configured: boolean;
  missing: string[];
  models: string[];
  error?: string;
};

function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

function uniqueProviders(profile: CouncilProfile): Map<string, Set<string>> {
  const providers = new Map<string, Set<string>>();
  for (const seat of [...profile.seats, profile.chair]) {
    const models = providers.get(seat.provider) ?? new Set<string>();
    models.add(seat.model);
    providers.set(seat.provider, models);
  }
  return providers;
}

export function providerReadiness(
  profile: CouncilProfile,
  environment: Environment = process.env,
): ProviderReadiness[] {
  return [...uniqueProviders(profile)]
    .map(([provider, models]) => {
      if (!isProviderId(provider)) {
        return {
          provider,
          configured: false,
          missing: [],
          models: [...models].sort(),
          error: "unsupported provider",
        };
      }
      const keyName = PROVIDERS[provider].apiKeyEnv;
      const missing = keyName && !environment[keyName]?.trim() ? [keyName] : [];
      return {
        provider,
        configured: missing.length === 0,
        missing,
        models: [...models].sort(),
      };
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

export function assertProvidersReady(
  profile: CouncilProfile,
  environment: Environment = process.env,
): void {
  const unready = providerReadiness(profile, environment).filter(
    (provider) => !provider.configured,
  );
  if (unready.length === 0) return;
  throw new Error(
    `provider readiness failed: ${unready
      .map((provider) =>
        provider.error
          ? `${provider.provider}: ${provider.error}`
          : `${provider.provider} needs ${provider.missing.join(", ")}`,
      )
      .join("; ")}`,
  );
}

function cleanBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("provider base URL must be a valid URL");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("provider base URL must use HTTPS or local HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "provider base URL cannot contain credentials, a query, or a fragment",
    );
  }
  return value.replace(/\/+$/, "");
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  const candidate =
    first >= 0 && last >= first ? unfenced.slice(first, last + 1) : unfenced;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asUsage(input: unknown, output: unknown): ModelUsage | undefined {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isInteger(output) ||
    output < 0
  ) {
    return undefined;
  }
  return { inputTokens: input, outputTokens: output };
}

async function apiError(
  response: Response,
  secretValues: string[],
): Promise<Error> {
  const raw = (await response.text()).slice(0, 1_500);
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message;
      if (typeof message === "string") detail = message;
    }
  } catch {
    // The HTTP status remains useful when the provider did not return JSON.
  }
  let redacted = detail;
  for (const secret of secretValues) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[REDACTED:provider-api-key]");
    }
  }
  const safe = sanitizeContent(redacted, "redact").text.replace(/\s+/g, " ");
  return new Error(
    `provider HTTP ${response.status}: ${safe || response.statusText}`,
  );
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  secretValues: string[],
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await apiError(response, secretValues);
  return (await response.json()) as unknown;
}

function openAiOutputText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of asArray(response.output)) {
    if (!isRecord(item)) continue;
    for (const content of asArray(item.content)) {
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }
  throw new Error("OpenAI response did not contain output text");
}

function anthropicOutputText(response: Record<string, unknown>): string {
  for (const content of asArray(response.content)) {
    if (
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string"
    ) {
      return content.text;
    }
  }
  throw new Error("Anthropic response did not contain text content");
}

function chatOutputText(response: Record<string, unknown>): string {
  const choice = asArray(response.choices)[0];
  if (isRecord(choice) && isRecord(choice.message)) {
    const content = choice.message.content;
    if (typeof content === "string") return content;
  }
  throw new Error("chat completion did not contain message content");
}

class OpenAiResponsesTransport implements ModelTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async generate(
    request: Parameters<ModelTransport["generate"]>[0],
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const response = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/responses`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: request.seat.model,
        instructions: request.system,
        input: request.prompt,
        max_output_tokens: request.seat.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: `council_${request.stage}`,
            strict: true,
            schema: OUTPUT_SCHEMAS[request.stage],
          },
        },
      },
      signal,
      [this.apiKey],
    );
    if (!isRecord(response))
      throw new Error("OpenAI response must be an object");
    const usage = isRecord(response.usage)
      ? asUsage(response.usage.input_tokens, response.usage.output_tokens)
      : undefined;
    const result: ModelResult = {
      output: parseJsonObject(openAiOutputText(response)),
    };
    if (usage) result.usage = usage;
    return result;
  }
}

class AnthropicMessagesTransport implements ModelTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async generate(
    request: Parameters<ModelTransport["generate"]>[0],
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const response = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model: request.seat.model,
        max_tokens: request.seat.maxOutputTokens,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        output_config: {
          format: {
            type: "json_schema",
            schema: OUTPUT_SCHEMAS[request.stage],
          },
        },
      },
      signal,
      [this.apiKey],
    );
    if (!isRecord(response)) {
      throw new Error("Anthropic response must be an object");
    }
    const usage = isRecord(response.usage)
      ? asUsage(response.usage.input_tokens, response.usage.output_tokens)
      : undefined;
    const result: ModelResult = {
      output: parseJsonObject(anthropicOutputText(response)),
    };
    if (usage) result.usage = usage;
    return result;
  }
}

class OpenAiChatTransport implements ModelTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async generate(
    request: Parameters<ModelTransport["generate"]>[0],
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const response = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: request.seat.model,
        messages: [
          {
            role: "system",
            content: `${request.system}\nReturn exactly one valid JSON object.`,
          },
          { role: "user", content: request.prompt },
        ],
        max_tokens: request.seat.maxOutputTokens,
        response_format: { type: "json_object" },
        stream: false,
      },
      signal,
      [this.apiKey],
    );
    if (!isRecord(response)) {
      throw new Error("chat completion response must be an object");
    }
    const usage = isRecord(response.usage)
      ? asUsage(response.usage.prompt_tokens, response.usage.completion_tokens)
      : undefined;
    const result: ModelResult = {
      output: parseJsonObject(chatOutputText(response)),
    };
    if (usage) result.usage = usage;
    return result;
  }
}

export type ProviderResolverOptions = {
  environment?: Environment;
  fetchImpl?: FetchLike;
};

export function createProviderResolver(
  options: ProviderResolverOptions = {},
): (seat: CouncilSeat) => ModelTransport {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return (seat) => {
    if (!isProviderId(seat.provider)) {
      throw new Error(`unsupported council provider: ${seat.provider}`);
    }
    const config = PROVIDERS[seat.provider];
    if (config.apiStyle === "fake") return new FakeCouncilTransport();
    const keyName = config.apiKeyEnv!;
    const apiKey = environment[keyName]?.trim();
    if (!apiKey) throw new Error(`${seat.provider} needs ${keyName}`);
    const configuredBaseUrl = config.baseUrlEnv
      ? environment[config.baseUrlEnv]?.trim()
      : undefined;
    const baseUrl = cleanBaseUrl(configuredBaseUrl || config.defaultBaseUrl!);
    if (config.apiStyle === "openai-responses") {
      return new OpenAiResponsesTransport(apiKey, baseUrl, fetchImpl);
    }
    if (config.apiStyle === "anthropic") {
      return new AnthropicMessagesTransport(apiKey, baseUrl, fetchImpl);
    }
    return new OpenAiChatTransport(apiKey, baseUrl, fetchImpl);
  };
}

import { sanitizeContent } from "./context";
import { FakeCouncilTransport } from "./engine";
import {
  type CouncilProfile,
  type CouncilSeat,
  type CouncilStage,
  type ModelResult,
  type ModelTransport,
  ModelTransportError,
  type ModelUsage,
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

const OUTPUT_SCHEMAS = {
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

function outputSchema(stage: CouncilStage): JsonSchema {
  return OUTPUT_SCHEMAS[stage === "revision" ? "peer" : stage];
}

// Anthropic rejects numerical limits in raw JSON schemas. Keep those checks in
// the engine parser and describe them to the model instead of sending keywords
// that its API rejects. Do not mutate the schema used by other providers.
function anthropicSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(anthropicSchema);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "minimum" && key !== "maximum") {
      result[key] = anthropicSchema(child);
    }
  }
  const constraints = [
    typeof value.minimum === "number"
      ? `Must be at least ${value.minimum}.`
      : "",
    typeof value.maximum === "number"
      ? `Must be at most ${value.maximum}.`
      : "",
  ].filter(Boolean);
  if (constraints.length > 0) {
    result.description = [value.description, ...constraints]
      .filter(Boolean)
      .join(" ");
  }
  return result;
}

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
  validation: "local-configuration-only";
  transport?: ProviderConfig["apiStyle"];
  outputFormat?: "json-schema" | "json-object" | "deterministic";
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
          validation: "local-configuration-only" as const,
          error: "unsupported provider",
        };
      }
      const config = PROVIDERS[provider];
      const keyName = config.apiKeyEnv;
      const missing = keyName && !environment[keyName]?.trim() ? [keyName] : [];
      let error: string | undefined;
      if (config.apiStyle !== "fake") {
        try {
          configuredBaseUrl(config, environment);
        } catch (caught) {
          error =
            caught instanceof Error
              ? caught.message
              : "invalid provider configuration";
        }
      }
      return {
        provider,
        configured: missing.length === 0 && !error,
        missing,
        models: [...models].sort(),
        validation: "local-configuration-only" as const,
        transport: config.apiStyle,
        outputFormat: (config.apiStyle === "fake"
          ? "deterministic"
          : config.apiStyle === "openai-chat"
            ? "json-object"
            : "json-schema") as NonNullable<ProviderReadiness["outputFormat"]>,
        ...(error ? { error } : {}),
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
  return url.toString().replace(/\/+$/, "");
}

function configuredBaseUrl(
  config: ProviderConfig,
  environment: Environment,
): string {
  const configured = config.baseUrlEnv
    ? environment[config.baseUrlEnv]?.trim()
    : undefined;
  return cleanBaseUrl(configured || config.defaultBaseUrl!);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(unfenced);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
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
  const raw = await response.text();
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
  const safe = safeProviderText(detail || response.statusText, secretValues);
  return new Error(`provider HTTP ${response.status}: ${safe}`);
}

function redactProviderText(text: string, secretValues: string[]): string {
  let redacted = text;
  for (const secret of secretValues) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[REDACTED:provider-api-key]");
    }
  }
  return sanitizeContent(redacted, "redact").text;
}

function safeProviderText(text: string, secretValues: string[]): string {
  // Redact complete values first. Truncating first can expose an unrecognizable
  // credential prefix at the boundary, especially after whitespace is collapsed.
  return redactProviderText(text, secretValues)
    .replace(/\s+/g, " ")
    .slice(0, 1_500);
}

function redactProviderValue(value: unknown, secretValues: string[]): unknown {
  if (typeof value === "string") return redactProviderText(value, secretValues);
  if (Array.isArray(value))
    return value.map((item) => redactProviderValue(item, secretValues));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        redactProviderText(key, secretValues),
        redactProviderValue(child, secretValues),
      ]),
    );
  }
  return value;
}

function responseResult(
  seat: CouncilSeat,
  usage: ModelUsage | undefined,
  secretValues: string[],
  readText: () => string,
): ModelResult {
  const accounting: {
    usage?: ModelUsage;
    estimatedUsageCostUsd?: number;
  } = {};
  if (usage) accounting.usage = usage;
  try {
    const rates = seat.tokenRatesUsdPerMillion;
    if (rates && usage) {
      const estimate =
        (usage.inputTokens * rates.input + usage.outputTokens * rates.output) /
        1_000_000;
      if (!Number.isFinite(estimate) || estimate < 0)
        throw new Error("invalid token cost estimate");
      accounting.estimatedUsageCostUsd = Number(estimate.toFixed(9));
    }
    const output = redactProviderValue(
      parseJsonObject(readText()),
      secretValues,
    );
    return { ...accounting, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelTransportError(
      safeProviderText(message, secretValues),
      accounting,
    );
  }
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  secretValues: string[],
): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!response.ok) throw await apiError(response, secretValues);
    return (await response.json()) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelTransportError(safeProviderText(message, secretValues));
  }
}

function openAiOutputText(response: Record<string, unknown>): string {
  if (response.status !== "completed") {
    const reason = isRecord(response.incomplete_details)
      ? response.incomplete_details.reason
      : undefined;
    throw new Error(
      `OpenAI response did not complete${typeof reason === "string" ? ` (${reason})` : ""}`,
    );
  }
  const texts: string[] = [];
  for (const item of asArray(response.output)) {
    if (!isRecord(item)) continue;
    for (const content of asArray(item.content)) {
      if (isRecord(content) && content.type === "refusal") {
        throw new Error("OpenAI refused the review request");
      }
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        texts.push(content.text);
      }
    }
  }
  if (texts.length > 0) return texts.join("");
  if (typeof response.output_text === "string") return response.output_text;
  throw new Error("OpenAI response did not contain output text");
}

function anthropicOutputText(response: Record<string, unknown>): string {
  if (response.stop_reason !== "end_turn") {
    throw new Error(
      `Anthropic response did not complete (${String(response.stop_reason ?? "missing stop reason")})`,
    );
  }
  const texts: string[] = [];
  for (const content of asArray(response.content)) {
    if (
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string"
    ) {
      texts.push(content.text);
    }
  }
  if (texts.length > 0) return texts.join("");
  throw new Error("Anthropic response did not contain text content");
}

function chatOutputText(response: Record<string, unknown>): string {
  const choice = asArray(response.choices)[0];
  if (isRecord(choice) && isRecord(choice.message)) {
    if (choice.finish_reason !== "stop") {
      throw new Error(
        `chat completion did not complete (${String(choice.finish_reason ?? "missing finish reason")})`,
      );
    }
    if (choice.message.refusal)
      throw new Error("provider refused the review request");
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
    private readonly secretValues: string[],
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
            schema: outputSchema(request.stage),
          },
        },
      },
      signal,
      this.secretValues,
    );
    if (!isRecord(response))
      throw new Error("OpenAI response must be an object");
    const usage = isRecord(response.usage)
      ? asUsage(response.usage.input_tokens, response.usage.output_tokens)
      : undefined;
    return responseResult(request.seat, usage, this.secretValues, () =>
      openAiOutputText(response),
    );
  }
}

class AnthropicMessagesTransport implements ModelTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly secretValues: string[],
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
            schema: anthropicSchema(outputSchema(request.stage)),
          },
        },
      },
      signal,
      this.secretValues,
    );
    if (!isRecord(response)) {
      throw new Error("Anthropic response must be an object");
    }
    const rawUsage = isRecord(response.usage) ? response.usage : undefined;
    const inputTokens =
      rawUsage && typeof rawUsage.input_tokens === "number"
        ? rawUsage.input_tokens +
          Number(rawUsage.cache_creation_input_tokens ?? 0) +
          Number(rawUsage.cache_read_input_tokens ?? 0)
        : undefined;
    const usage = rawUsage
      ? asUsage(inputTokens, rawUsage.output_tokens)
      : undefined;
    return responseResult(request.seat, usage, this.secretValues, () =>
      anthropicOutputText(response),
    );
  }
}

class OpenAiChatTransport implements ModelTransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly secretValues: string[],
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
      this.secretValues,
    );
    if (!isRecord(response)) {
      throw new Error("chat completion response must be an object");
    }
    const usage = isRecord(response.usage)
      ? asUsage(response.usage.prompt_tokens, response.usage.completion_tokens)
      : undefined;
    return responseResult(request.seat, usage, this.secretValues, () =>
      chatOutputText(response),
    );
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
  const secretValues = [
    ...new Set(
      Object.values(PROVIDERS).flatMap((config) => {
        const value = config.apiKeyEnv
          ? environment[config.apiKeyEnv]?.trim()
          : undefined;
        return value ? [value] : [];
      }),
    ),
  ].sort((left, right) => right.length - left.length);
  return (seat) => {
    if (!isProviderId(seat.provider)) {
      throw new Error(`unsupported council provider: ${seat.provider}`);
    }
    const config = PROVIDERS[seat.provider];
    if (config.apiStyle === "fake") return new FakeCouncilTransport();
    const keyName = config.apiKeyEnv!;
    const apiKey = environment[keyName]?.trim();
    if (!apiKey) throw new Error(`${seat.provider} needs ${keyName}`);
    const baseUrl = configuredBaseUrl(config, environment);
    if (config.apiStyle === "openai-responses") {
      return new OpenAiResponsesTransport(
        apiKey,
        baseUrl,
        fetchImpl,
        secretValues,
      );
    }
    if (config.apiStyle === "anthropic") {
      return new AnthropicMessagesTransport(
        apiKey,
        baseUrl,
        fetchImpl,
        secretValues,
      );
    }
    return new OpenAiChatTransport(apiKey, baseUrl, fetchImpl, secretValues);
  };
}

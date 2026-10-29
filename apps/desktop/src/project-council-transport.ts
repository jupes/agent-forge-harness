import { z } from "zod";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  projectCouncilHistorySchema,
  projectCouncilMetadataSchema,
  projectCouncilOriginalReadSchema,
  projectCouncilReceiptSchema,
  projectCouncilReserveRequestSchema,
  PROJECT_COUNCIL_MAX_METADATA_BYTES,
  PROJECT_COUNCIL_MAX_ORIGINAL_READ_BYTES,
  projectCouncilRequestIdSchema,
  type ProjectCouncilMetadata,
  type ProjectCouncilOriginalRead,
  type ProjectCouncilReceipt,
  type ProjectCouncilReserveRequest,
} from "../../../types/project-council";
import {
  MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES,
  projectCouncilRunReadSchema,
  type ProjectCouncilRunRead,
} from "../../../types/project-council-run-read";

if (typeof window !== "undefined") z.config({ jitless: true });

const seatSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  timeoutMs: z.number().int().positive().max(600_000),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  estimatedCostUsd: z.number().finite().nonnegative().max(1_000_000),
  tokenRatesUsdPerMillion: z.object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
  }).strict().optional(),
  openRouter: z.object({
    only: z.array(z.string().min(1).max(128)).max(64).optional(),
    allowFallbacks: z.boolean().optional(),
    dataCollection: z.enum(["deny", "allow"]).optional(),
    zeroDataRetention: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const readinessSchema = z.object({
  provider: z.string().min(1).max(64),
  configured: z.boolean(),
  missing: z.array(z.string().min(1).max(128)).max(64),
  models: z.array(z.string().min(1).max(256)).max(128),
  validation: z.literal("local-configuration-only"),
  transport: z.string().min(1).max(64).optional(),
  outputFormat: z.string().min(1).max(64).optional(),
  routing: z.array(z.object({
    seatId: z.string().min(1).max(128),
    require_parameters: z.literal(true),
    allow_fallbacks: z.boolean(),
    data_collection: z.enum(["deny", "allow"]),
    zdr: z.boolean(),
    only: z.array(z.string().min(1).max(128)).max(64).optional(),
  }).strict()).max(32).optional(),
  error: z.string().max(2048).optional(),
}).strict();

const profileChoiceSchema = z.object({
  path: z.string().min(1).max(4096),
  title: z.string().min(1).max(256),
  id: z.string().min(1).max(128),
  depth: z.enum(["quick", "balanced", "deep"]),
  maxEstimatedUsd: z.number().finite().nonnegative().max(1_000_000),
  seats: z.array(seatSchema).min(1).max(32),
  chair: seatSchema,
  readiness: z.array(readinessSchema).min(1).max(16),
}).strict();

export const projectCouncilProfilesSchema = z.array(profileChoiceSchema).max(128);
export type ProjectCouncilProfileChoice = z.infer<typeof profileChoiceSchema>;
export type ProjectCouncilHistory = z.infer<typeof projectCouncilHistorySchema>;

const envelope = z.object({ ok: z.boolean(), data: z.unknown().nullable(), error: z.string().nullable() }).strict();
function record<T>(raw: unknown, schema: z.ZodType<T>): T {
  const parsedEnvelope = envelope.safeParse(raw);
  if (!parsedEnvelope.success || !parsedEnvelope.data.ok || parsedEnvelope.data.error !== null)
    throw Error("The Council response could not be verified.");
  const parsed = schema.safeParse(parsedEnvelope.data.data);
  if (!parsed.success) throw Error("The Council response did not match its published contract.");
  return parsed.data;
}

async function jsonResponse<T>(response: Response, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("The Council response returned no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let raw: unknown;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw Error("The Council response exceeds its receiving limit.");
      }
      try { text += decoder.decode(part.value, { stream: true }); }
      catch {
        await reader.cancel();
        throw Error("The Council response contains invalid UTF-8.");
      }
    }
    try { text += decoder.decode(); raw = JSON.parse(text); }
    catch { throw Error("The Council response was not valid JSON."); }
  } finally {
    reader.releaseLock();
  }
  if (!response.ok) throw Error(`The Council request was refused (${response.status}).`);
  return record(raw, schema);
}

const withEnvelope = (dataBytes: number) => dataBytes + 1024;

export interface ProjectCouncilTransport {
  profiles(signal?: AbortSignal): Promise<ProjectCouncilProfileChoice[]>;
  history(projectId: string, signal?: AbortSignal): Promise<ProjectCouncilHistory>;
  original(projectId: string, requestId: string, signal?: AbortSignal): Promise<ProjectCouncilOriginalRead>;
  reserve(projectId: string, request: ProjectCouncilReserveRequest): Promise<{ metadata: ProjectCouncilMetadata; created: boolean }>;
  retire(projectId: string, requestId: string, intentHash: string): Promise<ProjectCouncilReceipt>;
  commit(projectId: string, requestId: string, intentHash: string): Promise<ProjectCouncilReceipt>;
  cancel(projectId: string, requestId: string, intentHash: string): Promise<ProjectCouncilReceipt>;
  run(projectId: string, requestId: string, signal?: AbortSignal): Promise<ProjectCouncilRunRead>;
}

function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/council/reviews`;
}

export function createProjectCouncilTransport(): ProjectCouncilTransport {
  return {
    async profiles(signal) {
      const response = await operatorRead("/__agent-forge/council-api/profiles", { signal }, { maxBodyBytes: 512 * 1024 });
      return jsonResponse(response, projectCouncilProfilesSchema, withEnvelope(512 * 1024));
    },
    async history(projectId, signal) {
      const response = await operatorRead(`/__agent-forge${projectPath(projectId)}`, { signal }, { maxBodyBytes: PROJECT_COUNCIL_MAX_METADATA_BYTES });
      return jsonResponse(response, projectCouncilHistorySchema, withEnvelope(PROJECT_COUNCIL_MAX_METADATA_BYTES));
    },
    async original(projectId, requestId, signal) {
      if (!projectCouncilRequestIdSchema.safeParse(requestId).success) throw Error("The saved original ID is invalid.");
      const response = await operatorRead(`/__agent-forge${projectPath(projectId)}/${encodeURIComponent(requestId)}`, { signal }, { maxBodyBytes: PROJECT_COUNCIL_MAX_ORIGINAL_READ_BYTES });
      return jsonResponse(response, projectCouncilOriginalReadSchema, withEnvelope(PROJECT_COUNCIL_MAX_ORIGINAL_READ_BYTES));
    },
    async reserve(projectId, request) {
      const strict = projectCouncilReserveRequestSchema.parse(request);
      const response = await operatorPost(`/__agent-forge${projectPath(projectId)}`, strict, { maxBodyBytes: 2 * 1024 * 1024 });
      const data = await jsonResponse(response, z.object({ metadata: projectCouncilMetadataSchema, created: z.boolean() }).strict(), withEnvelope(PROJECT_COUNCIL_MAX_METADATA_BYTES));
      return data;
    },
    async retire(projectId, requestId, intentHash) {
      if (!projectCouncilRequestIdSchema.safeParse(requestId).success || !/^[a-f0-9]{64}$/.test(intentHash)) throw Error("The saved original identity is invalid.");
      const response = await operatorPost(`/__agent-forge${projectPath(projectId)}/${encodeURIComponent(requestId)}/retire`, { intentHash }, { maxBodyBytes: PROJECT_COUNCIL_MAX_METADATA_BYTES });
      return jsonResponse(response, projectCouncilReceiptSchema, withEnvelope(PROJECT_COUNCIL_MAX_METADATA_BYTES));
    },
    async commit(projectId, requestId, intentHash) {
      if (!projectCouncilRequestIdSchema.safeParse(requestId).success || !/^[a-f0-9]{64}$/.test(intentHash)) throw Error("The saved original identity is invalid.");
      const response = await operatorPost(`/__agent-forge${projectPath(projectId)}/${encodeURIComponent(requestId)}/commit`, { intentHash }, { maxBodyBytes: PROJECT_COUNCIL_MAX_METADATA_BYTES });
      return jsonResponse(response, projectCouncilReceiptSchema, withEnvelope(PROJECT_COUNCIL_MAX_METADATA_BYTES));
    },
    async cancel(projectId, requestId, intentHash) {
      if (!projectCouncilRequestIdSchema.safeParse(requestId).success || !/^[a-f0-9]{64}$/.test(intentHash)) throw Error("The saved original identity is invalid.");
      const response = await operatorPost(`/__agent-forge${projectPath(projectId)}/${encodeURIComponent(requestId)}/cancel`, { intentHash }, { maxBodyBytes: PROJECT_COUNCIL_MAX_METADATA_BYTES });
      return jsonResponse(response, projectCouncilReceiptSchema, withEnvelope(PROJECT_COUNCIL_MAX_METADATA_BYTES));
    },
    async run(projectId, requestId, signal) {
      if (!projectCouncilRequestIdSchema.safeParse(requestId).success) throw Error("The saved original ID is invalid.");
      const response = await operatorRead(`/__agent-forge${projectPath(projectId)}/${encodeURIComponent(requestId)}/run`, { signal }, { maxBodyBytes: MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES });
      return jsonResponse(response, projectCouncilRunReadSchema, withEnvelope(MAX_PROJECT_COUNCIL_RUN_RESPONSE_BYTES));
    },
  };
}

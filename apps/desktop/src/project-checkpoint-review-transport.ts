import { z } from "zod";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES,
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES,
  PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES,
  type ProjectCheckpointReviewMetadata,
  type ProjectCheckpointReviewMetadataRead,
  type ProjectCheckpointReviewOriginalRead,
  type ProjectCheckpointReviewPrepareRequest,
  type ProjectCheckpointReviewReceipt,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewMetadataSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewPrepareRequestSchema,
  projectCheckpointReviewReceiptSchema,
  projectCheckpointReviewScopeSchema,
} from "../../../types/project-checkpoint-reviews";

const envelope = z
  .object({ ok: z.boolean(), data: z.unknown().nullable(), error: z.string().nullable() })
  .strict();
const requestId = z.string().uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);

async function jsonResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("The checkpoint review response had no complete body.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw Error("The checkpoint review response exceeded its receiving limit.");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw Error("The checkpoint review response was incomplete or invalid UTF-8.");
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error("The checkpoint review response was not valid JSON.");
  }
  const checkedEnvelope = envelope.safeParse(raw);
  if (!response.ok || !checkedEnvelope.success || !checkedEnvelope.data.ok || checkedEnvelope.data.error !== null)
    throw Error("The checkpoint review response could not be verified.");
  const checked = schema.safeParse(checkedEnvelope.data.data);
  if (!checked.success) throw Error("The checkpoint review response did not match its published contract.");
  return checked.data;
}

function base(scope: ProjectCheckpointReviewScope): string {
  const valid = projectCheckpointReviewScopeSchema.parse(scope);
  return `/__agent-forge/projects/${encodeURIComponent(valid.projectId)}/runs/${encodeURIComponent(valid.runSlug)}/checkpoints/${encodeURIComponent(valid.beadId)}/reviews`;
}

export interface ProjectCheckpointReviewTransport {
  metadata(scope: ProjectCheckpointReviewScope, signal?: AbortSignal): Promise<ProjectCheckpointReviewMetadataRead>;
  original(scope: ProjectCheckpointReviewScope, requestId: string, signal?: AbortSignal): Promise<ProjectCheckpointReviewOriginalRead>;
  prepare(scope: ProjectCheckpointReviewScope, request: ProjectCheckpointReviewPrepareRequest): Promise<ProjectCheckpointReviewMetadata>;
  commit(scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string): Promise<ProjectCheckpointReviewReceipt>;
  retire(scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string): Promise<ProjectCheckpointReviewReceipt>;
  readback(scope: ProjectCheckpointReviewScope, requestId: string, intentHash: string): Promise<ProjectCheckpointReviewReceipt>;
}

export function createProjectCheckpointReviewTransport(deps: {
  read?: typeof operatorRead;
  post?: typeof operatorPost;
} = {}): ProjectCheckpointReviewTransport {
  const read = deps.read ?? operatorRead;
  const post = deps.post ?? operatorPost;
  const metadata = async (scope: ProjectCheckpointReviewScope, signal?: AbortSignal) => {
    const response = await read(base(scope), signal ? { signal } : {}, {
      maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES + 1024,
    });
    return jsonResponse(
      response,
      projectCheckpointReviewMetadataReadSchema,
      PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES + 2048,
    );
  };
  const original = async (scope: ProjectCheckpointReviewScope, id: string, signal?: AbortSignal) => {
    if (!requestId.safeParse(id).success) throw Error("The saved checkpoint review ID is invalid.");
    const response = await read(`${base(scope)}/${encodeURIComponent(id)}`, signal ? { signal } : {}, {
      maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES + 2048,
    });
    return jsonResponse(
      response,
      projectCheckpointReviewOriginalReadSchema,
      PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES + 4096,
    );
  };
  const action = async (
    name: "commit" | "retire" | "readback",
    scope: ProjectCheckpointReviewScope,
    id: string,
    intentHash: string,
  ) => {
    if (!requestId.safeParse(id).success || !digest.safeParse(intentHash).success)
      throw Error("The saved checkpoint review identity is invalid.");
    const response = await post(`${base(scope)}/${encodeURIComponent(id)}/${name}`, { intentHash }, {
      maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES + 2048,
    });
    return jsonResponse(response, projectCheckpointReviewReceiptSchema, PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES + 4096);
  };
  return {
    metadata,
    original,
    async prepare(scope, request) {
      const strict = projectCheckpointReviewPrepareRequestSchema.parse(request);
      const response = await post(base(scope), strict, {
        maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES + 2048,
      });
      return jsonResponse(response, projectCheckpointReviewMetadataSchema, PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES + 4096);
    },
    commit: (scope, id, hash) => action("commit", scope, id, hash),
    retire: (scope, id, hash) => action("retire", scope, id, hash),
    readback: (scope, id, hash) => action("readback", scope, id, hash),
  };
}

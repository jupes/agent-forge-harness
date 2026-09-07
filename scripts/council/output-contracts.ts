import { z } from "zod";
import type { CouncilStage } from "./types";

export const FINDING_SEVERITIES = ["blocker", "high", "medium", "low"] as const;
const severity = z.enum(FINDING_SEVERITIES);
const strings = z.array(z.string());
// Refinements are enforced locally, not emitted as provider-specific keywords.
const nonempty = z
  .string()
  .refine((value) => value.trim() !== "", "must be a non-empty string");

export const findingSchema = z.object({
  localId: nonempty,
  title: nonempty,
  severity,
  claim: nonempty,
  consequence: nonempty,
  evidenceIds: strings,
  confidence: z.number().min(0).max(1),
});
export const independentSchema = z.object({
  verdict: z.enum(["pass", "needs_changes", "uncertain"]),
  findings: z.array(findingSchema),
  strengths: strings,
  unknowns: strings,
});
export const ballotSchema = z.object({
  candidateId: z
    .string()
    .refine((value) => value !== "", "must be a non-empty string"),
  stance: z.enum(["support", "oppose", "uncertain"]),
  reason: nonempty,
  evidenceIds: strings,
  suggestedSeverity: severity.nullable().optional(),
});
export const peerSchema = z.object({
  ballots: z.array(ballotSchema),
  missingFindings: z.array(findingSchema),
});
export const chairSchema = z.object({
  verdict: z.enum(["pass", "needs_changes", "insufficient_evidence"]),
  summary: nonempty,
  recommendations: strings,
  consensusFindingKeys: strings,
  dissentFindingKeys: strings,
});

export type FindingSeverity = z.infer<typeof severity>;
export type ProposedFinding = z.infer<typeof findingSchema>;
export type IndependentOutput = z.infer<typeof independentSchema>;
export type PeerBallot = Omit<
  z.infer<typeof ballotSchema>,
  "suggestedSeverity"
> & {
  suggestedSeverity?: FindingSeverity;
};
export type PeerOutput = Omit<z.infer<typeof peerSchema>, "ballots"> & {
  ballots: PeerBallot[];
};
export type ChairOutput = z.infer<typeof chairSchema>;

// Provider structured-output contracts require every field, with null for an
// omitted severity suggestion. Local parsing also accepts omission for existing
// JSON-mode clients and stored outputs. Unknown fields are stripped locally.
function providerSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, {
    target: "draft-7",
  });
  const requireFields = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(requireFields);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.type === "object" && object.properties) {
      object.required = Object.keys(object.properties);
      object.additionalProperties = false;
    }
    Object.values(object).forEach(requireFields);
  };
  requireFields(result);
  return result;
}
const schemas = {
  independent: providerSchema(independentSchema),
  peer: providerSchema(peerSchema),
  chair: providerSchema(chairSchema),
};
export function outputSchema(stage: CouncilStage): Record<string, unknown> {
  return structuredClone(schemas[stage === "revision" ? "peer" : stage]);
}

export function parseOutputContract<T>(
  schema: z.ZodType<T>,
  value: unknown,
  stage: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Only paths and validation messages are exposed, never the raw model data.
    throw new Error(
      `${stage} output invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

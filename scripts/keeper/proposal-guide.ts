import { z } from "zod";
import type { KeeperAutonomy } from "../../types/projects";
import { keeperProposalMessageSchema } from "./proposal-protocol";

export function keeperProposalGuide(mode: KeeperAutonomy | undefined): string {
  return mode === "suggest-only"
    ? "Keeper autonomy is Suggest only. Offer evidence-based recommendations in ordinary prose. Do not emit actionable proposal JSON or approval cards. Never claim to approve or start work. Existing approved work and originals are unaffected."
    : KEEPER_PROPOSAL_GUIDE;
}

/** This is an output format for inert suggestions, never another tool or an execution instruction. */
export const KEEPER_PROPOSAL_GUIDE = `When the owner asks for actionable proposals, return one whole JSON object matching the following schema, with no surrounding prose. Use only ids and repository values actually read in this project's scope. The message explains the evidence and limitations; each draft title and detail explains why the human might approve it. These are untrusted suggestions, never approval or success. The human must separately review each card. Session, shift and council destinations may be unavailable; never claim they started. Do not emit proposals for ordinary questions or brief requests. Keep the whole reply below 24000 UTF-8 bytes and do not include tokens, commands, flags, URLs, file contents, approval status or result fields. Schema: ${JSON.stringify(z.toJSONSchema(keeperProposalMessageSchema))}`;

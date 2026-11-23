import type { ConversationState } from "../../types/conversation";
import type { KeeperProposal } from "../../types/keeper-proposal";
import { hashText } from "../hash-text";
import { parseKeeperProposalMessage } from "./proposal-protocol";

export { parseKeeperProposalMessage } from "./proposal-protocol";

/** Server-derived provenance never grants the untrusted proposed arguments any authority. */
export function keeperProposals(state: ConversationState): KeeperProposal[] {
  const replies = new Map<
    string,
    { text: string; identity: boolean; brief: boolean }
  >();
  for (const frame of state.frames) {
    let reply = replies.get(frame.turnId);
    if (!reply) {
      reply = { text: "", identity: false, brief: false };
      replies.set(frame.turnId, reply);
    }
    if (frame.event.kind === "text") reply.text += frame.event.text;
    if (frame.event.kind === "user" && frame.event.brief) reply.brief = true;
    if (
      frame.event.kind === "identity" &&
      frame.event.provider === state.binding?.provider &&
      frame.event.sessionId === state.binding.sessionId
    )
      reply.identity = true;
  }
  const result: KeeperProposal[] = [];
  for (const turn of state.turns) {
    const reply = replies.get(turn.requestId);
    if (turn.phase !== "completed" || !reply?.identity || reply.brief) continue;
    const message = parseKeeperProposalMessage(reply.text);
    if (!message) continue;
    const sourceHash = hashText(reply.text);
    for (const [index, draft] of message.proposals.entries())
      result.push({
        id: `proposal-${turn.requestId}-${index}`,
        projectId: state.projectId,
        sourceRequestId: turn.requestId,
        sourceHash,
        createdAt: turn.updatedAt,
        draft,
      });
  }
  return result;
}

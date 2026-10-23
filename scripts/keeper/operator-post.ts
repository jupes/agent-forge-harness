import { z } from "zod";
import { ConversationError } from "../conversations/error";
import {
  type Exchange,
  type LoopbackAnswer,
  loopbackExchange,
} from "../hearth/loopback";
import { OPERATOR_HEADER } from "../hearth/paths";
import { BEAD_TEXT_LIMITS } from "../hearth/routes/beads";
import { keeperReaderOrigin } from "./reader";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const callSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("queue.move"),
      id,
      action: z.enum(["approve", "propose", "pause", "resume"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("queue.reassign"),
      id,
      smith: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bead.comment"),
      id,
      text: z.string().min(1).max(3500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bead.create"),
      title: z.string().min(1).max(200),
      type: z.enum(["task", "feature", "bug", "chore", "epic"]),
      priority: z.number().int().min(0).max(4),
      parentId: id,
      description: z
        .string()
        .min(1)
        .max(BEAD_TEXT_LIMITS.description)
        .refine((value) => value.trim() !== "-"),
    })
    .strict(),
]);
export type KeeperOperatorCall = z.infer<typeof callSchema>;
export type KeeperOperatorPost = (
  call: KeeperOperatorCall,
  signal?: AbortSignal,
) => Promise<LoopbackAnswer>;

/** Server-owned adapter: the caller supplies a closed intent, never a URL or operator header. */
export function createKeeperOperatorPost(options: {
  origin(): string;
  operatorToken(): string | null;
  exchange?: Exchange;
}) {
  const exchange = options.exchange ?? loopbackExchange;
  return async (
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<LoopbackAnswer> => {
    const parsed = callSchema.safeParse(raw);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a bounded supported Keeper operator call.",
      );
    const input = parsed.data,
      address = keeperReaderOrigin(options.origin()),
      token = options.operatorToken();
    if (!token)
      throw new ConversationError(
        503,
        "The operator token is unavailable. No mapped request was sent.",
      );
    let path: string, body: unknown;
    switch (input.kind) {
      case "queue.move":
        path = `/queue/${encodeURIComponent(input.id)}/${input.action}`;
        body = {};
        break;
      case "queue.reassign":
        path = `/queue/${encodeURIComponent(input.id)}/reassign`;
        body = { smith: input.smith };
        break;
      case "bead.comment":
        path = `/beads/${encodeURIComponent(input.id)}/comment`;
        body = { text: input.text };
        break;
      case "bead.create":
        path = "/beads";
        body = {
          title: input.title,
          type: input.type,
          priority: `P${input.priority}`,
          parent: input.parentId,
          description: input.description,
        };
        break;
    }
    return exchange({
      port: address.port,
      method: "POST",
      target: `/__agent-forge${path}`,
      headers: {
        Origin: address.origin,
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: token,
      },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
      maxBytes: 65_536,
      ...(signal ? { signal } : {}),
    });
  };
}

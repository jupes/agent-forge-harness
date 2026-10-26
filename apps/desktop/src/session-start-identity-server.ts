import type { OperatorPost, OperatorRead } from "../../../docs/js/operator";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
  SessionStartIdentityReply,
} from "../../../types/session-start-identities";
import type { OwnedSessionStartRequest } from "../../../types/codex-owned-task";

export interface VerifiedSessionIdentityScope {
  readonly projectId: string;
  readonly workspace: string;
  readonly generation: number;
}

export interface ReservedIdentityTuple
  extends Pick<
    SessionStartIdentityMetadata,
    "requestId" | "requestHash" | "provider" | "mode" | "state"
  > {}

export interface SessionStartIdentityServer {
  list(
    scope: VerifiedSessionIdentityScope,
    signal?: AbortSignal,
  ): Promise<SessionStartIdentityPage>;
  reserve(
    scope: VerifiedSessionIdentityScope,
    original: OwnedSessionStartRequest,
  ): Promise<{
    scope: SessionStartIdentityReply["scope"];
    identity: SessionStartIdentityMetadata;
    request: OwnedSessionStartRequest;
    requestHash: string;
  }>;
  retire(
    scope: VerifiedSessionIdentityScope,
    reserved: ReservedIdentityTuple,
  ): Promise<SessionStartIdentityReply>;
}

export interface SessionStartIdentityServerDependencies {
  currentScope(): VerifiedSessionIdentityScope | null;
  read: OperatorRead;
  post: OperatorPost;
}

/** The server-owned identity transport; implementations are added after the red checkpoint. */
export function createSessionStartIdentityServer(
  _dependencies: SessionStartIdentityServerDependencies,
): SessionStartIdentityServer {
  const notImplemented = async (): Promise<never> => {
    throw Error("Server-owned Session Start identity transport is unavailable.");
  };
  return {
    list: notImplemented,
    reserve: notImplemented,
    retire: notImplemented,
  };
}

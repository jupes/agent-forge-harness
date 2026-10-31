import type { AcpRpcId, AcpServerFrame } from "./acp-wire";

export type GrokAuthMethod = {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "terminal";
};

export type GrokAcpCapabilities = {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  embeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
};

export type GrokConnectionState =
  | { kind: "not-started" }
  | { kind: "initialize-pending"; requestId: AcpRpcId }
  | {
      kind: "initialized";
      authMethods: readonly GrokAuthMethod[];
      defaultAuthMethodId: string | null;
      capabilities: GrokAcpCapabilities;
      authentication: "unknown";
      identity: "unverified";
    }
  | {
      kind: "failed-closed";
      reason:
        | "mismatched-response"
        | "unsupported-version"
        | "invalid-initialize-result";
    };

/** Private Grok initialize transition; it performs no process or auth effects. */
export function reduceGrokInitialize(
  state: GrokConnectionState,
  _frame: AcpServerFrame,
): GrokConnectionState {
  return state;
}

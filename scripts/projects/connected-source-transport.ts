import { createHash } from "node:crypto";
import { toNamespacedPath } from "node:path";
import { lockPath, tokenPath } from "../hearth/home";
import { readHomeFileBounded, readHomeLock } from "../hearth/home-guard";
import { isPidAlive, sameLock } from "../hearth/lock";
import {
  type Exchange,
  healthReport,
  loopbackExchange,
} from "../hearth/loopback";
import { API_PREFIX, OPERATOR_HEADER, SURFACE_HEADER } from "../hearth/paths";
import { HEARTH_API_VERSION } from "../hearth/protocol";
import { physicalSourceText, pinSourceRoot } from "./connected-source-common";
import {
  type ConnectedScopePreview,
  SOURCE_RESPONSE_BYTES,
  type SourceInstanceIdentity,
  sourceInstanceSchema,
  sourcePreviewSchema,
} from "./connected-source-protocol";
import { ProjectStoreError } from "./store";

export class ReplacedWorkspaceSource extends ProjectStoreError {
  constructor() {
    super(409, "The workspace Hearth changed. Authorize its source again.");
  }
}
export interface ConnectedSource {
  identity: SourceInstanceIdentity;
  current(): boolean;
  preview(input: {
    projectId: string;
    revision: number;
    epicIds: readonly string[];
    signal?: AbortSignal;
  }): Promise<ConnectedScopePreview>;
}
export type ConnectWorkspaceSource = (
  canonicalRoot: string,
  signal?: AbortSignal,
) => Promise<ConnectedSource>;
const unavailable = () =>
  new ProjectStoreError(
    503,
    "The authorized running workspace source is unavailable. Refresh to check it.",
  );
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable();
  }
}
function envelopeData(answer: { status: number; body: string }): unknown {
  const parsed = parse(answer.body);
  if (
    answer.status !== 200 ||
    !parsed ||
    typeof parsed !== "object" ||
    !("ok" in parsed) ||
    parsed.ok !== true ||
    !("data" in parsed) ||
    !("error" in parsed) ||
    parsed.error !== null
  )
    throw unavailable();
  return parsed.data;
}
function sameIdentity(
  left: SourceInstanceIdentity,
  right: SourceInstanceIdentity,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.root === right.root &&
    left.pid === right.pid &&
    left.tracker.database === right.tracker.database &&
    left.tracker.projectId === right.tracker.projectId
  );
}

/** Known private home only; called AFTER explicit native consent to canonicalRoot. */
export function workspaceSourceConnector(
  home: string,
  exchange: Exchange = loopbackExchange,
): ConnectWorkspaceSource {
  return async (root, consentSignal) => {
    if (consentSignal?.aborted) throw unavailable();
    let retired = false;
    const replaced = (): never => {
      retired = true;
      throw new ReplacedWorkspaceSource();
    };
    const sameRoot = pinSourceRoot(root);
    // Rust canonical Windows paths may retain a verbatim prefix. Only these
    // two spellings of the ALREADY approved root are discovery candidates.
    const normalizedRoot = physicalSourceText(root);
    const aliases = [
      ...new Set(
        process.platform === "win32"
          ? [normalizedRoot, toNamespacedPath(normalizedRoot)]
          : [root],
      ),
    ];
    const candidates = [
      ...new Set(aliases.map((alias) => lockPath(home, alias))),
    ]
      .map((file) => ({ file }))
      .filter((candidate) => {
        const read = readHomeLock(home, candidate.file),
          lock = read.lock;
        try {
          return (
            read.problem === null &&
            lock !== null &&
            physicalSourceText(lock.root) === normalizedRoot &&
            lockPath(home, lock.root) === candidate.file &&
            lock.tokenFile === tokenPath(home, lock.root) &&
            isPidAlive(lock.pid)
          );
        } catch {
          return false;
        }
      });
    if (candidates.length !== 1) throw unavailable();
    const selected = candidates[0]!;
    const capture = () => {
      const file = selected.file,
        read = readHomeLock(home, file),
        lock = read.lock;
      if (
        read.problem !== null ||
        !lock ||
        physicalSourceText(lock.root) !== physicalSourceText(root) ||
        lockPath(home, lock.root) !== file ||
        lock.tokenFile !== tokenPath(home, lock.root) ||
        !isPidAlive(lock.pid)
      )
        throw unavailable();
      const token = readHomeFileBounded(home, tokenPath(home, lock.root), 128);
      if (
        token.problem !== null ||
        token.text === null ||
        !/^\s*[a-f0-9]{64}\s*$/.test(token.text)
      )
        throw unavailable();
      return {
        lock,
        token: token.text.trim(),
        tokenHash: createHash("sha256").update(token.text).digest("hex"),
      };
    };
    const bound = capture();
    const current = () => {
      if (retired) return false;
      if (!sameRoot()) {
        retired = true;
        return false;
      }
      try {
        const fresh = capture();
        if (
          !sameLock(bound.lock, fresh.lock) ||
          bound.tokenHash !== fresh.tokenHash
        )
          retired = true;
      } catch {
        retired = true;
      }
      return !retired;
    };
    const ensure = (signal?: AbortSignal) => {
      if (signal?.aborted) throw unavailable();
      if (!current()) replaced();
    };
    async function healthy(signal?: AbortSignal) {
      ensure(signal);
      const health = await healthReport(bound.lock, {
        exchange,
        expectedApiVersion: HEARTH_API_VERSION,
        ...(signal ? { signal } : {}),
      });
      if (health.problem !== null) {
        if (!health.silent) {
          retired = true;
          replaced();
        }
        throw unavailable();
      }
      ensure(signal);
    }
    async function request(
      target: string,
      maxBytes: number,
      signal?: AbortSignal,
    ) {
      ensure(signal);
      if (target.length > 16384) throw unavailable();
      return exchange({
        port: bound.lock.port,
        method: "GET",
        target,
        headers: {
          Origin: `http://127.0.0.1:${bound.lock.port}`,
          [OPERATOR_HEADER]: bound.token,
          [SURFACE_HEADER]: "ui",
        },
        timeoutMs: 8000,
        maxBytes,
        ...(signal ? { signal } : {}),
      });
    }
    async function readIdentity(signal?: AbortSignal) {
      const data = sourceInstanceSchema.parse(
        envelopeData(
          await request(
            API_PREFIX + "/workspace-source/identity",
            4096,
            signal,
          ),
        ),
      );
      if (
        data.pid !== bound.lock.pid ||
        physicalSourceText(data.root) !== physicalSourceText(root)
      )
        replaced();
      ensure(signal);
      return data;
    }
    await healthy(consentSignal);
    const identity = await readIdentity(consentSignal);
    await healthy(consentSignal);
    return {
      identity,
      current,
      async preview(input) {
        await healthy(input.signal);
        const query = new URLSearchParams({
          revision: String(input.revision),
          instance: identity.instanceId,
          trackerId: identity.tracker.projectId,
        });
        for (const id of input.epicIds) query.append("epicId", id);
        const answer = await request(
          `${API_PREFIX}/workspace-source/projects/${encodeURIComponent(input.projectId)}/preview?${query}`,
          SOURCE_RESPONSE_BYTES,
          input.signal,
        );
        const after = await readIdentity(input.signal);
        if (!sameIdentity(identity, after)) replaced();
        await healthy(input.signal);
        ensure(input.signal);
        if (answer.status === 409)
          throw new ProjectStoreError(
            409,
            "The source or project Scope changed. Refresh before saving.",
          );
        const result = sourcePreviewSchema.parse(envelopeData(answer));
        if (
          !sameIdentity(identity, result.instance) ||
          result.projectId !== input.projectId ||
          result.catalogRevision !== input.revision ||
          JSON.stringify(result.epicIds) !==
            JSON.stringify([...input.epicIds].sort())
        )
          replaced();
        return result;
      },
    };
  };
}

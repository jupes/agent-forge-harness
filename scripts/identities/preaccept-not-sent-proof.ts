import { isReadOnlyCapabilityRefusal } from "../sessions/read-only-capability-refusal";
import type { RestartIdentityInput } from "./restart-index";

type IdentityClaim = Readonly<
  RestartIdentityInput & { attemptGeneration: number }
>;
declare const proofBrand: unique symbol;
declare const emptySourceBrand: unique symbol;
declare const attemptBrand: unique symbol;

/** An in-process capability; it has no serializable authority. */
export type PreacceptNotSentProof = { readonly [proofBrand]: true };
export type EmptyInitialStartProof = { readonly [emptySourceBrand]: true };
export type InitialStartAttempt = { readonly [attemptBrand]: true };

const proofs = new WeakMap<object, IdentityClaim>();
const emptySources = new WeakMap<object, RestartIdentityInput>();
const attempts = new WeakMap<
  object,
  { claim: IdentityClaim; accepted: boolean; refused: boolean }
>();
const knownPreparationRefusals = new WeakSet<object>();

const sameClaim = (left: IdentityClaim, right: IdentityClaim) =>
  left.version === right.version &&
  left.address.family === right.address.family &&
  left.address.projectId === right.address.projectId &&
  left.workspace === right.workspace &&
  left.requestId === right.requestId &&
  left.requestHash === right.requestHash &&
  left.provider === right.provider &&
  left.mode === right.mode &&
  left.attemptGeneration === right.attemptGeneration;

function createProof(claim: IdentityClaim): PreacceptNotSentProof {
  const proof = Object.freeze(Object.create(null)) as PreacceptNotSentProof;
  proofs.set(
    proof,
    Object.freeze({ ...claim, address: Object.freeze({ ...claim.address }) }),
  );
  return proof;
}

/** Source reader only: caller must have strictly verified an empty initial source. */
export function attestEmptyInitialStart(
  identity: RestartIdentityInput,
): EmptyInitialStartProof {
  const proof = Object.freeze(Object.create(null)) as EmptyInitialStartProof;
  emptySources.set(
    proof,
    Object.freeze({
      ...identity,
      address: Object.freeze({ ...identity.address }),
    }),
  );
  return proof;
}

/** Creates one per-claim boundary only from a source-reader attestation. */
export function createInitialStartAttempt(
  identity: RestartIdentityInput,
  attemptGeneration: number,
  source: EmptyInitialStartProof,
): InitialStartAttempt {
  const sourceIdentity =
    typeof source === "object" && source !== null
      ? emptySources.get(source)
      : undefined;
  if (
    sourceIdentity === undefined ||
    !sameClaim(
      { ...sourceIdentity, attemptGeneration },
      { ...identity, attemptGeneration },
    )
  )
    throw new Error("An empty initial Start source is required.");
  const attempt = Object.freeze(Object.create(null)) as InitialStartAttempt;
  attempts.set(attempt, {
    claim: Object.freeze({
      ...identity,
      address: Object.freeze({ ...identity.address }),
      attemptGeneration,
    }),
    accepted: false,
    refused: false,
  });
  return attempt;
}

/** Marks every potentially effectful store.accept path before entering it. */
export function markInitialStartAcceptEntered(
  attempt: InitialStartAttempt | undefined,
): void {
  if (typeof attempt !== "object" || attempt === null) return;
  const state = attempts.get(attempt);
  if (state !== undefined) state.accepted = true;
}

/** Marks only errors explicitly tagged at the read-only capability preparation boundary. */
export function markKnownPreacceptPreparationRefusal<T extends Error>(
  error: T,
  source: unknown,
): T {
  if (isReadOnlyCapabilityRefusal(source)) knownPreparationRefusals.add(error);
  return error;
}

export function noteInitialStartPreparationRefusal(
  attempt: InitialStartAttempt | undefined,
  error: unknown,
): void {
  if (
    typeof attempt !== "object" ||
    attempt === null ||
    typeof error !== "object" ||
    error === null ||
    !knownPreparationRefusals.has(error)
  )
    return;
  const state = attempts.get(attempt);
  if (state !== undefined && !state.accepted) state.refused = true;
}

/** Returns a durable-settlement proof only after the controlled preaccept refusal path. */
export function proofForInitialStartRefusal(
  attempt: InitialStartAttempt | undefined,
): PreacceptNotSentProof | null {
  if (typeof attempt !== "object" || attempt === null) return null;
  const state = attempts.get(attempt);
  if (state === undefined || state.accepted || !state.refused) return null;
  attempts.delete(attempt);
  return createProof(state.claim);
}

export function readPreacceptNotSentProof(
  proof: PreacceptNotSentProof,
  identity: RestartIdentityInput,
  attemptGeneration: number,
): boolean {
  if (typeof proof !== "object" || proof === null) return false;
  const claim = proofs.get(proof);
  return (
    claim !== undefined && sameClaim(claim, { ...identity, attemptGeneration })
  );
}

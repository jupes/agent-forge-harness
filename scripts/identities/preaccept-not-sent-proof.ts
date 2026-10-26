import type { RestartIdentityInput } from "./restart-index";

type IdentityClaim = Readonly<
  RestartIdentityInput & { attemptGeneration: number }
>;
declare const proofBrand: unique symbol;

/** An in-process capability; it has no serializable authority. */
export type PreacceptNotSentProof = { readonly [proofBrand]: true };

const proofs = new WeakMap<object, IdentityClaim>();

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

/** Backend-only boundary used after a source has proven it never entered accept. */
export function provePreacceptNotSent(
  claim: IdentityClaim,
): PreacceptNotSentProof {
  const proof = Object.freeze(Object.create(null)) as PreacceptNotSentProof;
  proofs.set(
    proof,
    Object.freeze({ ...claim, address: Object.freeze({ ...claim.address }) }),
  );
  return proof;
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

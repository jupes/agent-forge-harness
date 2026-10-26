import { keeperShiftStartHashInputs } from "../../../scripts/keeper/shift-start-wire";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartProposal,
  KeeperShiftStartReceipt,
  KeeperShiftStartRequest,
} from "../../../types/keeper-shift-start";

const encoder = new TextEncoder();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function keeperShiftStartHashesInBrowser(
  projectId: string,
  proposalId: string,
  workspace: string,
  proposal: KeeperShiftStartProposal,
  request: KeeperShiftStartRequest,
): Promise<{ startHash: string; reviewHash: string }> {
  const inputs = keeperShiftStartHashInputs(
    projectId,
    proposalId,
    workspace,
    proposal,
    request,
    "",
  );
  const startHash = await sha256(inputs.startInput);
  const reviewInput = keeperShiftStartHashInputs(
    projectId,
    proposalId,
    workspace,
    proposal,
    request,
    startHash,
  ).reviewInput;
  return { startHash, reviewHash: await sha256(reviewInput) };
}

export async function verifyKeeperShiftIntentHashes(
  intent: KeeperShiftStartIntent,
): Promise<boolean> {
  const hashes = await keeperShiftStartHashesInBrowser(
    intent.projectId,
    intent.proposalId,
    intent.workspace,
    intent.proposal,
    intent.original,
  );
  return (
    intent.startHash === hashes.startHash &&
    intent.reviewHash === hashes.reviewHash
  );
}

export async function verifyKeeperShiftReceiptHashes(
  receipt: KeeperShiftStartReceipt,
): Promise<boolean> {
  const action = receipt.record.draft.action;
  if (action.kind !== "start-shift") return false;
  const hashes = await keeperShiftStartHashesInBrowser(
    receipt.projectId,
    receipt.proposalId,
    receipt.workspace,
    {
      durationMinutes: action.durationMinutes,
      concurrency: action.concurrency,
      beadLimit: action.beadLimit,
      spendLimitUsd: action.spendLimitUsd,
    },
    receipt.original,
  );
  return (
    receipt.startHash === hashes.startHash &&
    receipt.record.requestHash === hashes.reviewHash
  );
}

import type { CouncilDiscussionRound, PeerBallot } from "./types";

export function previousBallot(
  rounds: CouncilDiscussionRound[],
  roundIndex: number,
  seatId: string,
  candidateId: string,
): PeerBallot | undefined {
  for (let index = roundIndex - 1; index >= 0; index--) {
    const output = rounds[index]?.records.find(
      (record) => record.seatId === seatId,
    )?.output;
    if (output && "ballots" in output) {
      const ballot = output.ballots.find(
        (item) => item.candidateId === candidateId,
      );
      if (ballot) return ballot;
    }
  }
  return undefined;
}

export function ballotChanged(
  previous: PeerBallot,
  current: PeerBallot,
): boolean {
  return (
    previous.stance !== current.stance ||
    previous.suggestedSeverity !== current.suggestedSeverity
  );
}

export function roundTitle(round: CouncilDiscussionRound): string {
  return round.stage === "independent"
    ? "Independent reviews"
    : round.stage === "peer"
      ? "Peer critique"
      : `Rebuttal ${round.round ?? 1}`;
}

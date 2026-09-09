import { useState } from "preact/hooks";
import {
  ballotChanged,
  previousBallot,
  roundTitle,
} from "../../../scripts/council/discussion";
import type {
  CouncilDiscussionRound,
  ProposedFinding,
} from "../../../scripts/council/types";

function Proposal({ finding }: { finding: ProposedFinding }) {
  return (
    <div className="discussion-entry">
      <h4>
        {finding.title} <span className="pill warning">{finding.severity}</span>
      </h4>
      <p>{finding.claim}</p>
      <p className="muted">{finding.consequence}</p>
      <p className="muted">
        Evidence: {finding.evidenceIds.join(", ") || "none"}
      </p>
    </div>
  );
}

export function CouncilDiscussion({
  rounds,
}: {
  rounds: CouncilDiscussionRound[];
}) {
  const [selected, setSelected] = useState(-1);
  if (!rounds.length) return null;
  const index =
    selected < 0 ? rounds.length - 1 : Math.min(selected, rounds.length - 1);
  const round = rounds[index]!;
  const prior = rounds[index - 1];
  const changes = round.findings.flatMap((finding) => {
    const before = prior?.findings.find((item) => item.key === finding.key);
    if (
      !before ||
      (before.resolution === finding.resolution &&
        before.severity === finding.severity)
    )
      return [];
    return [
      `${finding.title}: ${before.resolution} / ${before.severity} → ${finding.resolution} / ${finding.severity}`,
    ];
  });
  return (
    <section className="discussion" aria-label="Council discussion">
      <h2>Inside the discussion</h2>
      <p className="muted">
        Validated reviews appear after each round. These are provisional
        findings, not the final verdict.
      </p>
      <div
        className="discussion-tabs"
        role="group"
        aria-label="Choose discussion round"
      >
        {rounds.map((item, itemIndex) => (
          <button
            type="button"
            key={`${item.stage}-${item.round ?? 0}`}
            aria-pressed={index === itemIndex}
            className={index === itemIndex ? "" : "secondary"}
            onClick={() => setSelected(itemIndex)}
          >
            {roundTitle(item)}
          </button>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => setSelected(-1)}
          aria-pressed={selected === -1}
        >
          Follow latest
        </button>
      </div>
      <h3>{roundTitle(round)}</h3>
      <p className="muted">
        {round.records.filter((record) => record.status === "completed").length}{" "}
        completed ·{" "}
        {
          round.findings.filter(
            (finding) =>
              finding.resolution === "contested" ||
              finding.resolution === "unreviewed",
          ).length
        }{" "}
        unresolved findings
      </p>
      {changes.length > 0 && (
        <div className="notice">
          <h4>What changed this round</h4>
          <ul>
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>
      )}
      {round.records.map((record, recordIndex) => {
        const output = record.output;
        return (
          <details
            className="discussion-member"
            key={`${index}-${record.seatId}`}
            open={recordIndex === 0 || record.status !== "completed"}
          >
            <summary>
              {record.seatId} · {record.model} · {record.status}
            </summary>
            {record.error && <p className="notice error">{record.error}</p>}
            {output && "findings" in output && (
              <>
                <p className="round-label">
                  Initial verdict: {output.verdict.replaceAll("_", " ")}
                </p>
                {output.findings.map((finding) => (
                  <Proposal key={finding.localId} finding={finding} />
                ))}
                {!output.findings.length && <p>No findings proposed.</p>}
                {output.strengths.length > 0 && (
                  <>
                    <h4>Strengths</h4>
                    <ul>
                      {output.strengths.map((text, i) => (
                        <li key={i}>{text}</li>
                      ))}
                    </ul>
                  </>
                )}
                {output.unknowns.length > 0 && (
                  <>
                    <h4>Unknowns</h4>
                    <ul>
                      {output.unknowns.map((text, i) => (
                        <li key={i}>{text}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {output && "ballots" in output && (
              <>
                {output.ballots.map((ballot) => {
                  const previous = previousBallot(
                    rounds,
                    index,
                    record.seatId,
                    ballot.candidateId,
                  );
                  return (
                    <div className="discussion-entry" key={ballot.candidateId}>
                      <h4>
                        {round.candidateTitles[ballot.candidateId] ??
                          ballot.candidateId}
                      </h4>
                      <span
                        className={`pill${ballot.stance === "support" ? "" : " warning"}`}
                      >
                        {ballot.stance}
                      </span>
                      {previous && (
                        <span className="vote-change">
                          {ballotChanged(previous, ballot)
                            ? `Changed: ${previous.stance} → ${ballot.stance}; severity ${previous.suggestedSeverity ?? "as proposed"} → ${ballot.suggestedSeverity ?? "as proposed"}`
                            : "Position retained after rebuttal"}
                        </span>
                      )}
                      <p>{ballot.reason}</p>
                      <p className="muted">
                        Evidence: {ballot.evidenceIds.join(", ") || "none"}
                        {ballot.suggestedSeverity
                          ? ` · Suggested severity: ${ballot.suggestedSeverity}`
                          : ""}
                      </p>
                      {previous && ballotChanged(previous, ballot) && (
                        <details>
                          <summary>Earlier rationale</summary>
                          <p>{previous.reason}</p>
                        </details>
                      )}
                    </div>
                  );
                })}
                {output.missingFindings.length > 0 && (
                  <>
                    <h4>New findings raised</h4>
                    {output.missingFindings.map((finding) => (
                      <Proposal key={finding.localId} finding={finding} />
                    ))}
                  </>
                )}
                {!output.ballots.length && !output.missingFindings.length && (
                  <p>No eligible peer findings to discuss.</p>
                )}
              </>
            )}
          </details>
        );
      })}
    </section>
  );
}

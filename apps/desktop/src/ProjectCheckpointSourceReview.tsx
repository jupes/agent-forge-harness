import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { ProjectCheckpointReview } from "./ProjectCheckpointReview";
import type {
  ProjectCheckpointReviewOwner,
  ProjectCheckpointReviewTarget,
} from "./project-checkpoint-review-client";
import {
  captureProjectCheckpointSourceReview,
  createProjectCheckpointSourceOwner,
} from "./project-checkpoint-source-client";

export function ProjectCheckpointSourceReview({
  target,
  reviewOwner,
  writable,
  active,
}: {
  target: ProjectCheckpointReviewTarget;
  reviewOwner(
    target: ProjectCheckpointReviewTarget,
  ): ProjectCheckpointReviewOwner;
  writable: boolean;
  active: boolean;
}) {
  const owner = reviewOwner(target);
  const source = useMemo(
    () =>
      createProjectCheckpointSourceOwner(target, {
        active,
        writable,
        onRevoke: () => owner.invalidatePending(),
      }),
    [owner],
  );
  const [, update] = useState(source.get());
  const frame = {},
    rendered = useRef(frame),
    alive = useRef(false);
  rendered.current = frame;
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      source.dispose();
    };
  }, [source]);
  useLayoutEffect(() => {
    let current = true;
    const unsubscribe = source.subscribe(() => {
      if (current) update(source.get());
    });
    source.setTarget(target, { active, writable });
    void source.refresh();
    update(source.get());
    return () => {
      current = false;
      unsubscribe();
      source.setTarget(target, { active: false, writable: false });
    };
  }, [source, JSON.stringify(target), active, writable]);
  const checked = captureProjectCheckpointSourceReview(
    source,
    target,
    { active, writable },
    () => alive.current && rendered.current === frame,
  );
  const submitted = checked.context?.record;
  return (
    <section
      data-checkpoint-source=""
      tabIndex={-1}
      aria-label={"Checkpoint source " + target.beadId}
    >
      {active && (
        <>
          <h5>Submitted source</h5>
          {checked.loading ? (
            <p role="status">Checking committed checkpoint source…</p>
          ) : checked.error ? (
            <p role="alert">{checked.error}</p>
          ) : checked.sourceReady && submitted?.original.kind === "publish" ? (
            <>
              <p>
                Submitted commit{" "}
                <code>{submitted.original.sourceVersion.commit}</code>
              </p>
              <small>
                Source generation {checked.context?.generation} · request{" "}
                <code>{submitted.original.requestId}</code>. Uncommitted changes
                are excluded. Submission does not approve this checkpoint.
              </small>
            </>
          ) : (
            <p>
              {checked.context?.state === "stale"
                ? "The submitted source has changed. Check and submit the current committed source before choosing a review decision."
                : checked.context?.state === "withdrawn"
                  ? "This source submission was withdrawn."
                  : checked.context?.state === "foreign"
                    ? "Another retained checkpoint scope owns this source submission."
                    : "No current verified source submission is available for a new review decision."}
            </p>
          )}
          <Button
            data-checkpoint-source-check=""
            disabled={!writable || checked.loading}
            onClick={() => void checked.refresh()}
          >
            Check current source
          </Button>
        </>
      )}
      <ProjectCheckpointReview
        target={checked.target}
        owner={owner}
        writable={writable}
        active={active}
        sourceReady={checked.sourceReady}
        isSourceCurrent={checked.isSourceCurrent}
      />
    </section>
  );
}

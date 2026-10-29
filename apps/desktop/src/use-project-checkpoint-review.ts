import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ProjectCheckpointReviewOwner,
  ProjectCheckpointReviewView,
} from "./project-checkpoint-review-client";

export function selectProjectCheckpointReviewView(
  owner: ProjectCheckpointReviewOwner,
  snapshot: {
    owner: ProjectCheckpointReviewOwner;
    view: ProjectCheckpointReviewView;
  },
): ProjectCheckpointReviewView {
  return snapshot.owner === owner ? snapshot.view : owner.get();
}

export function useProjectCheckpointReview(
  owner: ProjectCheckpointReviewOwner,
): ProjectCheckpointReviewView {
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [snapshot, setSnapshot] = useState(() => ({
    owner,
    view: owner.get(),
  }));
  const view = selectProjectCheckpointReviewView(owner, snapshot);
  useEffect(() => {
    let active = true;
    setSnapshot({ owner, view: owner.get() });
    const unsubscribe = owner.subscribe(() => {
      if (active && currentOwner.current === owner)
        setSnapshot({ owner, view: owner.get() });
    });
    void owner.refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [owner]);
  return view;
}

import { useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost } from "../../../docs/js/operator";
import {
  pageReads,
  readOperatorRoute,
  useOperatorRead,
} from "../../../docs/js/use-stream";
import type { LedgerEventKind } from "../../../types/hearth";
import type { ProjectsHome } from "../../../types/project-summary";
import type { ProjectPreferences } from "../../../types/projects";

const KINDS: readonly LedgerEventKind[] = [
  "operator.action",
  "bead.transitioned",
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.called",
  "run.phase.entered",
  "run.phase.completed",
  "review.recorded",
  "gate.ran",
];

/** Kept at the app root: navigating away cannot discard an unknown write. */
export function useProjects() {
  const read = useOperatorRead<ProjectsHome>("/projects/summary", KINDS, true);
  const [checked, setChecked] = useState<ProjectsHome | null>(null);
  const [notice, setNotice] = useState("");
  const [held, setHeld] = useState(false);
  const lock = useRef(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const phase = useRef<"idle" | "posting" | "checking" | "unknown">("idle");
  const home =
    checked &&
    (!read.data ||
      checked.catalog.revision > read.data.catalog.revision ||
      (checked.catalog.revision === read.data.catalog.revision &&
        checked.asOf > read.data.asOf))
      ? checked
      : read.data;
  const verify = async () => {
    phase.current = "checking";
    setNeedsCheck(false);
    try {
      const fresh = await readOperatorRoute<ProjectsHome>(
        "/projects/summary",
        pageReads(),
      );
      setChecked(fresh);
      setHeld(false);
      lock.current = false;
      phase.current = "idle";
      setNotice("Project preferences checked against the hearth.");
      read.reload();
    } catch {
      phase.current = "unknown";
      setNeedsCheck(true);
      setNotice(
        "Could not check project preferences. Check again when the hearth is available.",
      );
    }
  };
  const check = async () => {
    if (phase.current !== "unknown") return;
    await verify();
  };
  const change = async (id: string, patch: ProjectPreferences) => {
    if (lock.current || !home) return;
    lock.current = true;
    phase.current = "posting";
    setHeld(true);
    setNotice("Saving project preferences…");
    const outcome = await actionOutcome(
      () =>
        operatorPost(
          `/__agent-forge/projects/${encodeURIComponent(id)}/preferences`,
          { revision: home.catalog.revision, ...patch },
        ),
      "The preference may have changed. Check the project before trying again.",
    );
    if (outcome.state === "unknown") {
      phase.current = "unknown";
      setNeedsCheck(true);
      setNotice(outcome.message);
      return;
    }
    if (outcome.state === "refused") {
      setNotice(outcome.message);
      setHeld(false);
      lock.current = false;
      phase.current = "idle";
      read.reload();
      return;
    }
    // A confirmed read supplies the displayed state; never optimistically toggle.
    await verify();
  };
  return { ...read, data: home, notice, held, needsCheck, change, check };
}

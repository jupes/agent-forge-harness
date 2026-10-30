import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Field, Textarea } from "../../../docs/js/ds/Field";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import {
  forgeRunPrefill,
  type ForgeRunMode,
  type ForgeRunPrefill,
  type ForgeRunSource,
} from "./forge-run-prefill";

export interface NewForgeRunProps {
  projectId: string;
  workspace: string;
  beadsPage: ProjectBeadsPage | null;
  beadsLoading: boolean;
  beadsError: string | null;
  onContinue(prefill: ForgeRunPrefill): "applied" | "confirm" | string;
  onReplace(prefill: ForgeRunPrefill): string | null;
  onKeep(): string | null;
  onCancel(): void;
}

type Step = "input" | "review" | "confirm";

export function NewForgeRun({
  projectId,
  workspace,
  beadsPage,
  beadsLoading,
  beadsError,
  onContinue,
  onReplace,
  onKeep,
  onCancel,
}: NewForgeRunProps): JSX.Element {
  const [mode, setMode] = useState<ForgeRunMode>("full");
  const [sourceKind, setSourceKind] = useState<ForgeRunSource["kind"]>("text");
  const [text, setText] = useState("");
  const [beadId, setBeadId] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [problem, setProblem] = useState("");
  const [prefill, setPrefill] = useState<ForgeRunPrefill | null>(null);
  const scopedBeads =
    !beadsLoading &&
    !beadsError &&
    beadsPage?.projectId === projectId &&
    beadsPage.workspace === workspace &&
    beadsPage.complete &&
    beadsPage.problems.length === 0
      ? beadsPage.beads.filter(
          (bead) => bead.type === "feature" || bead.type === "epic",
        )
      : [];
  const selectedBead = scopedBeads.find((bead) => bead.id === beadId);
  const currentPrefill = useMemo(() => {
    try {
      const source: ForgeRunSource | null =
        sourceKind === "text"
          ? { kind: "text", text }
          : selectedBead
            ? {
                kind: "bead",
                id: selectedBead.id,
                title: selectedBead.title,
              }
            : null;
      return source ? { value: forgeRunPrefill(mode, source), error: "" } : null;
    } catch (error) {
      return {
        value: null,
        error:
          error instanceof Error
            ? error.message
            : "Review the selected feature input.",
      };
    }
  }, [mode, sourceKind, text, selectedBead]);

  const review = () => {
    if (!currentPrefill?.value) {
      setProblem(
        currentPrefill?.error ??
          (sourceKind === "bead" && !beadsPage
            ? beadsError ||
              (beadsLoading
                ? "Wait for the scoped bead read to finish."
                : "The scoped bead list is unavailable.")
            : "Choose one verified feature or epic bead."),
      );
      return;
    }
    setPrefill(currentPrefill.value);
    setProblem("");
    setStep("review");
  };
  const continueToComposer = () => {
    if (!prefill) return;
    const outcome = onContinue(prefill);
    if (outcome === "applied") return;
    if (outcome === "confirm") {
      setStep("confirm");
      setProblem("");
      return;
    }
    setProblem(outcome);
  };
  const replace = () => {
    if (!prefill) return;
    const error = onReplace(prefill);
    if (error) setProblem(error);
  };
  const keep = () => {
    const error = onKeep();
    if (error) setProblem(error);
  };

  return (
    <div class="af-new-forge-run">
      {step === "input" ? (
        <>
          <p>
            Prepare an attended run prompt for the existing Claude composer. No
            run starts here.
          </p>
          <Field label="Run size" id="forge-run-mode">
            <select
              id="forge-run-mode"
              class="af-input"
              value={mode}
              onChange={(event) =>
                setMode(event.currentTarget.value as ForgeRunMode)
              }
            >
              <option value="full">Full</option>
              <option value="mini">Mini</option>
            </select>
          </Field>
          <fieldset>
            <legend>Execution</legend>
            <label>
            <input type="radio" checked disabled /> Gated (attended)
            </label>
            <label title="Unattended runs wait for local model execution.">
            <input type="radio" disabled /> Unattended
            </label>
            <p class="af-field-hint">
              Unattended runs are unavailable in v1; they wait for local model
              execution.
            </p>
          </fieldset>
          <fieldset>
            <legend>Feature input</legend>
            <label>
              <input
                type="radio"
                name="forge-run-source"
                value="text"
                checked={sourceKind === "text"}
                onChange={() => setSourceKind("text")}
              />
              Describe the feature
            </label>
            <label>
              <input
                type="radio"
                name="forge-run-source"
                value="bead"
                checked={sourceKind === "bead"}
                onChange={() => setSourceKind("bead")}
              />
              Use a scoped bead
            </label>
          </fieldset>
          {sourceKind === "text" ? (
            <Field
              label="Feature description"
              id="forge-run-feature"
              required
              hint="The text is preserved exactly. Route and smith flags are controlled above."
            >
              <Textarea
                id="forge-run-feature"
                value={text}
                rows={5}
                autofocus
                onInput={(event) => setText(event.currentTarget.value)}
              />
            </Field>
          ) : (
            <Field
              label="Feature or epic bead"
              id="forge-run-bead"
              {...(beadsPage &&
              (beadsPage.projectId !== projectId ||
                beadsPage.workspace !== workspace ||
                !beadsPage.complete ||
                beadsPage.problems.length > 0)
                ? {
                    hint: "The current bead membership read is incomplete or out of scope.",
                  }
                : {})}
            >
              <select
                id="forge-run-bead"
                class="af-input"
                value={beadId}
                disabled={scopedBeads.length === 0}
                onChange={(event) => setBeadId(event.currentTarget.value)}
              >
                <option value="">Choose a feature or epic</option>
                {scopedBeads.map((bead) => (
                  <option value={bead.id} key={bead.id}>
                    {bead.id} · {bead.title}
                  </option>
                ))}
              </select>
              {beadsLoading ? (
                <p role="status">Checking scoped bead membership…</p>
              ) : beadsError ? (
                <p role="alert">{beadsError}</p>
              ) : null}
            </Field>
          )}
        </>
      ) : (
        <>
          <p>
            {step === "confirm"
              ? "This composer already has a draft. Choose whether to keep it or replace its prompt and feature context."
              : "Review the exact prompt before transferring it to the Claude composer."}
          </p>
          <pre class="af-new-forge-run-prompt">
            <code>{prefill?.prompt ?? ""}</code>
          </pre>
          {prefill?.beadId ? (
            <p>Scoped bead: {prefill.beadId}</p>
          ) : null}
        </>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
      <div class="af-dialog-actions">
        {step === "input" ? (
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={review}>
              Review generated prompt
            </Button>
          </>
        ) : step === "review" ? (
          <>
            <Button onClick={() => setStep("input")}>Edit input</Button>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={continueToComposer}>
              Continue to Claude composer
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button onClick={keep}>Keep current draft</Button>
            <Button variant="primary" onClick={replace}>
              Replace current draft
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

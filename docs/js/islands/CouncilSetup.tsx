import type { ProviderReadiness } from "../../../scripts/council/providers";
import type { CouncilProfile } from "../../../scripts/council/types";
import {
  type CouncilPreviewState,
  needsPreview,
  previewAllowsSend,
  previewOf,
} from "../council-preview";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Field, Input, Select, Textarea } from "../ds/Field";
import { Icon } from "../ds/Icon";
import { Tag } from "../ds/Tag";

export type ProfileChoice = Pick<
  CouncilProfile,
  "id" | "title" | "seats" | "chair" | "depth" | "maxEstimatedUsd"
> & {
  path: string;
  readiness: ProviderReadiness[];
};

export type CouncilDraft = {
  sourceType: string;
  source: string;
  profilePath: string;
  budget: string;
  redactSecrets: boolean;
};

export function optionalBudget(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}
type Props = {
  draft: CouncilDraft;
  profiles: ProfileChoice[];
  active: boolean;
  starting: boolean;
  /**
   * Convene is held: a start was sent and its outcome is not known, so a run
   * may have begun. Released once the page has read the runs list again.
   */
  held?: boolean;
  /** The last preview asked for; shown only while it is of this draft. */
  preview: CouncilPreviewState;
  onChange: (patch: Partial<CouncilDraft>) => void;
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
  onPreview: () => Promise<void>;
};

/**
 * What a run on a bead would send, part by part, before it sends anything.
 * Called as a function, so it is part of the setup's own tree.
 */
function evidencePreview({
  state,
  bead,
  disabled,
  onPreview,
}: {
  state: CouncilPreviewState;
  /** The bead in the source field, as typed. */
  bead: string;
  disabled: boolean;
  onPreview: () => Promise<void>;
}) {
  const loading = state.status === "loading";
  return (
    <div class="af-evidence-preview">
      <div class="af-button-row">
        <Button onClick={() => void onPreview()} disabled={disabled || loading}>
          {loading ? "Reading the bead…" : "Preview evidence"}
        </Button>
      </div>
      {bead ? (
        <p class="af-muted">
          When the run completes, its verdict is posted to {bead} as a{" "}
          <code>review:</code> comment. A run that fails or is stopped posts
          nothing.
        </p>
      ) : null}
      {state.status === "ready" ? (
        <>
          <p class="af-muted">
            What the council will send for{" "}
            <strong>{state.preview.source.displayName}</strong>:{" "}
            {state.preview.byteLength} bytes
            {state.preview.truncated
              ? ", not all of it: what is cut or left out is listed"
              : ""}
            {state.preview.redactions.length > 0
              ? `; replaced: ${state.preview.redactions
                  .map((redaction) => `${redaction.kind} ×${redaction.count}`)
                  .join(", ")}`
              : ""}
            . The bead is read again when the run starts.
          </p>
          <ul class="af-evidence-listing" data-testid="council-preview-listing">
            {state.preview.listing.map((line, index) => (
              // A listing's lines are its order, and two may read alike.
              <li key={`${index} ${line}`}>{line}</li>
            ))}
          </ul>
        </>
      ) : state.status === "failed" ? (
        <p class="af-notice af-notice-error" role="alert">
          {state.error}
        </p>
      ) : (
        <p class="af-muted">
          A bead's acceptance criteria, comments, description, linked plan and
          pull request go to every provider of the profile. Preview them first:
          each part is listed, and nothing is sent.
        </p>
      )}
    </div>
  );
}

export function CouncilSetup({
  draft,
  profiles,
  active,
  starting,
  held = false,
  preview,
  onChange,
  onStart,
  onCancel,
  onPreview,
}: Props) {
  const { sourceType, source, profilePath, budget, redactSecrets } = draft;
  const profile = profiles.find((item) => item.path === profilePath);
  const ready = profile?.readiness.every((entry) => entry.configured) ?? false;
  const bead = sourceType === "bead";
  const shown = previewOf(preview, draft);

  const sourceLabel =
    sourceType === "text"
      ? "Document or question"
      : sourceType === "pr"
        ? "PR number or GitHub URL"
        : bead
          ? "Beads issue id"
          : "File path within this workspace";

  const sourcePlaceholder =
    sourceType === "text"
      ? "Paste the work, its goals, and the evidence the reviewers should consider…"
      : sourceType === "pr"
        ? "https://github.com/owner/repo/pull/123"
        : bead
          ? "agent-forge-harness-x1gs.7"
          : "plans/drafts/my-plan.md";

  return (
    <Card title="What should the council review?" headingLevel={2}>
      <div class="af-form-grid">
        <Field label="Source" id="council-source-type">
          <Select
            id="council-source-type"
            value={sourceType}
            onChange={(event) =>
              onChange({ sourceType: event.currentTarget.value })
            }
            disabled={active}
          >
            <option value="text">Paste a document</option>
            <option value="pr">GitHub pull request</option>
            <option value="plan">Local Markdown plan</option>
            <option value="file">Local research or text file</option>
            <option value="bead">Beads issue</option>
          </Select>
        </Field>

        <Field label="Council profile" id="council-profile">
          <Select
            id="council-profile"
            value={profilePath}
            onChange={(event) => {
              const path = event.currentTarget.value;
              onChange({
                profilePath: path,
                budget: String(
                  profiles.find((choice) => choice.path === path)
                    ?.maxEstimatedUsd ?? 3,
                ),
              });
            }}
            disabled={active}
          >
            {profiles.map((choice) => (
              <option key={choice.path} value={choice.path}>
                {choice.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={sourceLabel} id="council-source" class="af-form-wide">
          {bead ? (
            <Input
              id="council-source"
              value={source}
              onInput={(event) =>
                onChange({ source: event.currentTarget.value })
              }
              placeholder={sourcePlaceholder}
              disabled={active}
              autocomplete="off"
            />
          ) : (
            <Textarea
              id="council-source"
              value={source}
              onInput={(event) =>
                onChange({ source: event.currentTarget.value })
              }
              placeholder={sourcePlaceholder}
              disabled={active}
              rows={5}
            />
          )}
        </Field>

        {needsPreview(sourceType) ? (
          <div class="af-form-wide">
            {evidencePreview({
              state: shown,
              bead: source.trim(),
              disabled: active || !source.trim(),
              onPreview,
            })}
          </div>
        ) : null}

        <Field label="Run budget (USD)" id="council-budget">
          <Input
            id="council-budget"
            type="number"
            value={budget}
            onInput={(event) => onChange({ budget: event.currentTarget.value })}
            disabled={active}
          />
        </Field>

        <label class="af-check">
          <input
            type="checkbox"
            checked={redactSecrets}
            onChange={(event) =>
              onChange({ redactSecrets: event.currentTarget.checked })
            }
            disabled={active}
          />
          Redact detected secrets; otherwise reject
        </label>
      </div>

      {profile?.readiness.length ? (
        <div class="af-readiness">
          {profile.readiness.map((entry) => (
            <Tag
              key={entry.provider}
              tone={entry.configured ? "neutral" : "outline"}
            >
              <Icon
                name={entry.configured ? "check-circle-fill" : "warning-circle"}
                size={12}
              />
              {entry.provider}:{" "}
              {entry.configured
                ? "configured"
                : (entry.error ?? `needs ${entry.missing.join(", ")}`)}
            </Tag>
          ))}
        </div>
      ) : null}

      <p class="af-prose af-muted">
        {profile?.seats.every((seat) => seat.provider === "fake")
          ? "Demo profile: simulated feedback, no API keys or model charges."
          : "Your selected providers receive the supplied review material. Configure keys in the server environment; never paste them here."}
      </p>

      {profile?.readiness.some((entry) => entry.routing) ? (
        <details class="af-details">
          <summary>Gateway routing policy</summary>
          {profile.readiness.flatMap((entry) =>
            (entry.routing ?? []).map((routing) => (
              <p key={routing.seatId} class="af-muted">
                {routing.seatId}:{" "}
                {routing.only?.join(", ") ?? "any eligible endpoint"} · fallback{" "}
                {routing.allow_fallbacks ? "enabled" : "disabled"} · data
                collection {routing.data_collection} · zero-retention filter{" "}
                {routing.zdr ? "on" : "off"} · structured parameters required
              </p>
            )),
          )}
        </details>
      ) : null}

      {profile &&
      [...profile.seats, profile.chair].some(
        (seat) => seat.provider === "openrouter",
      ) ? (
        <p class="af-notice">
          One-key gateway: set OPENROUTER_API_KEY in the server environment.
          Review material goes through OpenRouter and its upstream providers.
          The profile controls retention filtering and fallback; inspect it
          before sending private work. Readiness checks configuration, not live
          availability.
        </p>
      ) : null}

      <div class="af-form-actions af-form-actions-split">
        <span class="af-muted">{profile?.depth ?? "balanced"} discussion</span>
        <div class="af-button-row">
          {active ? (
            <Button onClick={() => void onCancel()}>Stop review</Button>
          ) : null}
          <Button
            variant="primary"
            onClick={() => void onStart()}
            disabled={
              active ||
              starting ||
              held ||
              !ready ||
              !source.trim() ||
              !previewAllowsSend(preview, draft) ||
              budget.trim() === "" ||
              !Number.isFinite(Number(budget)) ||
              Number(budget) < 0
            }
          >
            {starting ? "Starting…" : "Convene council"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

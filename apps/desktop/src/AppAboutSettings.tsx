import { version } from "../../../package.json";
import { HEARTH_API_VERSION } from "../../../scripts/hearth/protocol";

/** Bundled metadata and an internal entry to the existing shared diagnostics owner. */
export function AppAboutSettings({
  diagnosticsHref,
}: {
  diagnosticsHref: string;
}) {
  return (
    <section
      class="af-app-hearth af-app-about"
      aria-labelledby="app-about-heading"
    >
      <h3 id="app-about-heading">About</h3>
      <dl>
        <dt>Renderer release version</dt>
        <dd>
          <code>{version}</code>
        </dd>
        <dt>Expected Hearth API compatibility version</dt>
        <dd>{HEARTH_API_VERSION}</dd>
      </dl>
      <p>
        Release metadata identifies this renderer. Live Hearth compatibility is
        checked separately by the connection banner; these values do not prove
        native delivery or release acceptance.
      </p>
      <h4>Doctor</h4>
      <p>
        Provider diagnostics separates executable discovery, version response,
        authentication, adapter support and reported usage. A version response
        alone does not prove sign-in.
      </p>
      <a class="af-btn af-btn-secondary" href={diagnosticsHref}>
        Open provider diagnostics
      </a>
      <p>
        Opening diagnostics runs no Doctor action, sign-in or provider task.
        Choose Run doctor on the provider card to explicitly refresh its
        non-generating checks.
      </p>
    </section>
  );
}

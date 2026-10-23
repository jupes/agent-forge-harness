import { Button } from "../../../docs/js/ds/Button";
import { KeeperMarkdown } from "./KeeperMarkdown";

/** Shared safe assistant presentation; copying has no execution or provider authority. */
export function SessionReply({
  text,
  streaming = false,
  onCopy,
}: {
  text: string;
  streaming?: boolean;
  onCopy?: ((text: string) => void) | undefined;
}) {
  if (!text) return null;
  return (
    <article class="af-owned-reply" aria-label="Session reply">
      <KeeperMarkdown text={text} />
      {streaming && (
        <span class="af-session-streaming-caret" aria-hidden="true" />
      )}
      <Button disabled={!onCopy} onClick={() => onCopy?.(text)}>
        Copy session reply
      </Button>
    </article>
  );
}

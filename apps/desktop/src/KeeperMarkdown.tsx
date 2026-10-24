import type { ComponentChildren, JSX } from "preact";

/** Small Markdown subset rendered as elements. Raw HTML and images remain escaped text. */
function inline(text: string): ComponentChildren {
  const pieces: ComponentChildren[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<!!)\[[^\]\n]+\]\([^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    pieces.push(text.slice(offset, match.index));
    const token = match[0];
    if (token.startsWith("`")) pieces.push(<code>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**"))
      pieces.push(<strong>{token.slice(2, -2)}</strong>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? "";
      if (/^https?:\/\//i.test(href) && href.length <= 2048)
        pieces.push(
          <a href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      else pieces.push(token);
    }
    offset = match.index + token.length;
  }
  pieces.push(text.slice(offset));
  return pieces;
}
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
export function KeeperMarkdown({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const blocks: ComponentChildren[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index] ?? ""))
        code.push(lines[index++] ?? "");
      index++;
      blocks.push(
        // biome-ignore lint/a11y/noNoninteractiveTabindex: an overflowing code block must support keyboard scrolling.
        <pre tabIndex={0}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
        lines[index + 1] ?? "",
      )
    ) {
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").includes("|") &&
        (lines[index] ?? "").trim()
      )
        rows.push(cells(lines[index++] ?? ""));
      blocks.push(
        <div
          class="af-keeper-table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the named table region must support keyboard scrolling.
          tabIndex={0}
          role="region"
          aria-label="Keeper table"
        >
          <table>
            <thead>
              <tr>
                {header.map((cell) => (
                  <th>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  {header.map((_, column) => (
                    <td>{inline(row[column] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h3>{inline(heading[2] ?? "")}</h3>);
      index++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? ""))
        items.push((lines[index++] ?? "").replace(/^\s*[-*+]\s+/, ""));
      blocks.push(
        <ul>
          {items.map((item) => (
            <li>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? ""))
        items.push((lines[index++] ?? "").replace(/^\s*\d+\.\s+/, ""));
      blocks.push(
        <ol>
          {items.map((item) => (
            <li>{inline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (/^>\s?/.test(line))
      blocks.push(<blockquote>{inline(line.replace(/^>\s?/, ""))}</blockquote>);
    else blocks.push(<p>{inline(line)}</p>);
    index++;
  }
  return <div class="af-keeper-markdown">{blocks}</div>;
}

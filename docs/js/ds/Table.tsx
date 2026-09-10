import type { ComponentChildren, JSX } from "preact";

export interface TableColumn<Row> {
  key: string;
  header: ComponentChildren;
  /** Cell renderer; defaults to the row's value at `key`. */
  cell?: (row: Row) => ComponentChildren;
  /** Extra class for both the header and its cells (widths, alignment). */
  class?: string;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Shown in place of the table body when there are no rows. */
  empty?: ComponentChildren;
  /** Accessible name for the scroll region. */
  label?: string;
  /** Extra attributes per row — used for expandable issue rows. */
  rowProps?: (row: Row) => JSX.HTMLAttributes<HTMLTableRowElement>;
  /** Rendered directly after a row (the expanded detail panel). */
  rowDetail?: (row: Row) => ComponentChildren;
  class?: string;
}

/**
 * A data table in a scroll region.
 *
 * Wide tables scroll inside their own container rather than pushing the page
 * sideways; the region is focusable so it stays reachable by keyboard.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  empty,
  label,
  rowProps,
  rowDetail,
  class: className,
}: TableProps<Row>): JSX.Element {
  return (
    <div
      class={["af-table-scroll", className].filter(Boolean).join(" ")}
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to be scrollable by keyboard (WCAG 2.1.1) — role=region + aria-label + tabIndex=0 is the documented pattern for this case, not stray tab-order noise.
      tabIndex={0}
      aria-label={label}
    >
      <table class="af-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" class={column.class}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length > 0 ? (
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const detail = rowDetail?.(row);
              return (
                <>
                  <tr key={key} {...(rowProps?.(row) ?? {})}>
                    {columns.map((column) => (
                      <td key={column.key} class={column.class}>
                        {column.cell
                          ? column.cell(row)
                          : String(
                              (row as Record<string, unknown>)[column.key] ??
                                "",
                            )}
                      </td>
                    ))}
                  </tr>
                  {detail ? (
                    <tr key={`${key}-detail`} class="af-table-detail-row">
                      <td colSpan={columns.length}>{detail}</td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        ) : null}
      </table>
      {rows.length === 0 && empty !== undefined ? (
        <p class="af-table-empty">{empty}</p>
      ) : null}
    </div>
  );
}

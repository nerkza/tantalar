/**
 * Shared dense-grid primitives (story 27, extended Wave 9 TAN-036/037/038):
 * a TanStack Table wrapper with sorting, text filtering, column show/hide
 * customization, and density control. Grid layout choices persist per user
 * through ui-preferences.
 *
 * Wave 9 additions:
 *  - `loading` renders fixed-height placeholder rows so table geometry never
 *    jumps when data arrives;
 *  - an accessible caption names the grid for screen readers;
 *  - the filter input exposes an explicit label relationship.
 */
import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Group, Menu, TextInput, Button, Table, Box, Skeleton } from "@mantine/core";

export interface DenseGridProps<T> {
  columns: ReadonlyArray<ColumnDef<T, unknown>>;
  data: readonly T[];
  testId: string;
  /** Persisted layout: hidden columns + density. */
  layout?: GridLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  emptyMessage?: string;
  /** While true, placeholder rows render with stable geometry. */
  loading?: boolean;
  /** Accessible name for the table. Defaults to the test id. */
  ariaLabel?: string;
}

export interface GridLayout {
  hiddenColumns: readonly string[];
  density: "dense" | "comfortable";
}

const LOADING_ROWS = 5;

export function DenseGrid<T>({ columns, data, testId, layout, onLayoutChange, emptyMessage, loading, ariaLabel }: DenseGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const hidden = new Set(layout?.hiddenColumns ?? []);
  const visibleColumns = useMemo(
    () => columns.filter((c) => {
      const id = typeof c.id === "string" ? c.id : String(c.id ?? "");
      return !id || !hidden.has(id);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, layout?.hiddenColumns],
  );

  const table = useReactTable({
    data: [...data],
    columns: [...visibleColumns],
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: "includesString",
  });

  const toggleColumn = (id: string) => {
    if (!onLayoutChange || !layout) return;
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onLayoutChange({ ...layout, hiddenColumns: [...next] });
  };

  const padding = layout?.density === "dense" ? "4px 8px" : "8px 12px";
  const leafCount = visibleColumns.length;

  return (
    <Box data-testid={testId}>
      <Group justify="space-between" mb="xs" wrap="wrap">
        <TextInput
          aria-label={`Filter ${ariaLabel ?? testId}`}
          placeholder="Filter…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.currentTarget.value)}
          w={220}
        />
        {onLayoutChange && layout ? (
          <Menu shadow="sm">
            <Menu.Target>
              <Button variant="default" aria-haspopup="menu">Customize</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Columns</Menu.Label>
              {columns.map((c) => {
                const id = String(c.id ?? "");
                if (!id) return null;
                return (
                  <Menu.Item
                    key={id}
                    onClick={() => toggleColumn(id)}
                    rightSection={hidden.has(id) ? undefined : "✓"}
                  >
                    {id}
                  </Menu.Item>
                );
              })}
              <Menu.Divider />
              <Menu.Item onClick={() => onLayoutChange({ ...layout, density: layout.density === "dense" ? "comfortable" : "dense" })}>
                Density: {layout.density}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : null}
      </Group>
      <Table.ScrollContainer minWidth={400}>
        <Table
          highlightOnHover
          captionSide="top"
          className={layout?.density === "dense" ? "tantalar-grid-dense" : undefined}
          aria-label={ariaLabel ?? testId}
        >
          <Table.Thead>
            {table.getHeaderGroups().map((hg) => (
              <Table.Tr key={hg.id}>
                {hg.headers.map((h) => (
                  <Table.Th
                    key={h.id}
                    aria-sort={
                      h.column.getIsSorted() === "asc"
                        ? "ascending"
                        : h.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                    style={{ cursor: h.column.getCanSort() && !loading ? "pointer" : undefined, padding }}
                    onClick={h.column.getToggleSortingHandler()}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && h.column.getCanSort()) {
                        e.preventDefault();
                        h.column.getToggleSortingHandler()?.(e);
                      }
                    }}
                    tabIndex={h.column.getCanSort() && !loading ? 0 : -1}
                  >
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() ? (h.column.getIsSorted() === "asc" ? " ▲" : " ▼") : ""}
                  </Table.Th>
                ))}
              </Table.Tr>
            ))}
          </Table.Thead>
          <Table.Tbody className={loading ? "tantalar-grid-loading" : undefined}>
            {loading ? (
              Array.from({ length: LOADING_ROWS }, (_, i) => (
                <Table.Tr key={`loading-${i}`}>
                  {Array.from({ length: leafCount }, (_, j) => (
                    <Table.Td key={j} style={{ padding }}>
                      <Skeleton height={12} radius="sm" />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={leafCount} style={{ padding }}>
                  {emptyMessage ?? "Nothing to show."}
                </Table.Td>
              </Table.Tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <Table.Tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <Table.Td key={cell.id} style={{ padding }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Box>
  );
}

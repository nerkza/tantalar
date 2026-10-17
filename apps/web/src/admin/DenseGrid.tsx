/**
 * Shared dense-grid primitives (story 27, extended Wave 9 TAN-036/037/038):
 * a TanStack Table wrapper with sorting, text filtering, column show/hide
 * customization, sizing, ordering, and density control. Callers can persist
 * the resulting layout through their existing preference store.
 *
 * Wave 9 additions:
 *  - `loading` renders fixed-height placeholder rows so table geometry never
 *    jumps when data arrives;
 *  - an accessible caption names the grid for screen readers;
 *  - the filter input exposes an explicit label relationship.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  functionalUpdate,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Cell,
  type ColumnDef,
  type PaginationState,
  type RowData,
} from "@tanstack/react-table";
import { Group, Menu, TextInput, Button, Table, Box, NativeSelect, Select, Skeleton, Text } from "@mantine/core";
import { IconTablecells, IconListBullet, IconRectangleSplit2x1, IconSquareGrid3x3, IconSquareGrid2x2, IconSquare, IconLine3HorizontalDecrease } from "symbols-react";
import { api } from "../api";
import { labelKind, metadataLabel } from "../state-label";
import { ActionNotice } from "../components/ActionNotice";
import "./DenseGrid.css";

export const CollectionUserContext = createContext<string | null>(null);
export type CollectionView = "details" | "list" | "columns" | "small" | "medium" | "large";
export interface ExplorerQuery {
  search: string;
  sort: string;
  desc: boolean;
  page: number;
  pageSize: number;
  filters: Record<string, string>;
}
export const initialExplorerQuery: ExplorerQuery = { search: "", sort: "", desc: false, page: 1, pageSize: 25, filters: {} };
const views = [
  { value: "details", label: "Details", icon: IconTablecells }, { value: "list", label: "List", icon: IconListBullet },
  { value: "columns", label: "Two columns", icon: IconRectangleSplit2x1 }, { value: "small", label: "Small tiles", icon: IconSquareGrid3x3 },
  { value: "medium", label: "Medium tiles", icon: IconSquareGrid2x2 }, { value: "large", label: "Large tiles", icon: IconSquare },
] as const;
function readLayout(value: unknown): GridLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as GridLayout;
  return {
    density: p.density === "comfortable" ? "comfortable" : "dense",
    hiddenColumns: Array.isArray(p.hiddenColumns) ? p.hiddenColumns.filter(x => typeof x === "string") : [],
    view: views.some(v => v.value === p.view) ? p.view : undefined,
    columnOrder: Array.isArray(p.columnOrder) ? p.columnOrder.filter(x => typeof x === "string") : [],
    columnWidths: p.columnWidths && typeof p.columnWidths === "object" ? Object.fromEntries(Object.entries(p.columnWidths).filter(([,v]) => typeof v === "number" && Number.isFinite(v) && v >= 48 && v <= 2000)) : {},
    sorting: Array.isArray(p.sorting) ? p.sorting.filter(x => x && typeof x.id === "string" && typeof x.desc === "boolean") : [],
  };
}

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    dataType?: "number" | "time";
    labelFilter?: boolean;
    secondary?: boolean;
    /** Basic metadata shown beside the title in columns and tiles. */
    compact?: boolean;
  }
}

export interface DenseGridProps<T> {
  columns: ReadonlyArray<ColumnDef<T, unknown>>;
  data: readonly T[];
  testId: string;
  /** Persisted layout: visibility, order, widths, sorting, and density. */
  layout?: GridLayout;
  onLayoutChange?: (layout: GridLayout) => void;
  emptyMessage?: string;
  /** While true, placeholder rows render with stable geometry. */
  loading?: boolean;
  /** Accessible name for the table. Defaults to the test id. */
  ariaLabel?: string;
  /** Opt in to bounded client-side pages with 25/50/100 row sizes. */
  pagination?: boolean;
  /** Reset to page one when an external filter such as category changes. */
  paginationResetKey?: string | number;
  /** Make the full row the activation target instead of adding an action column. */
  onRowActivate?: (row: T) => void;
  isRowSelected?: (row: T) => boolean;
  rowAriaLabel?: (row: T) => string;
  rowTestId?: (row: T) => string;
  /** Optional mode-specific control rendered beside the text filter. */
  toolbarStart?: ReactNode;
  searchControl?: ReactNode;
  defaultView?: CollectionView;
  artwork?: (row: T) => ReactNode;
  filters?: readonly { id: string; label: string; options: readonly { value: string; label: string }[] }[];
  /** Remote collections return only the requested page and the full filtered count. */
  onQueryChange?: (query: ExplorerQuery) => void;
  total?: number;
}

export interface GridLayout {
  view?: CollectionView;
  hiddenColumns: readonly string[];
  density: "dense" | "comfortable";
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  sorting?: readonly { readonly id: string; readonly desc: boolean }[];
}

const LOADING_ROWS = 5;

export function DenseGrid<T>({
  columns,
  data,
  testId,
  layout: controlledLayout,
  onLayoutChange: controlledChange,
  emptyMessage,
  loading,
  ariaLabel,
  pagination: paginationEnabled = true,
  paginationResetKey,
  onRowActivate,
  isRowSelected,
  rowAriaLabel,
  rowTestId,
  toolbarStart,
  searchControl,
  defaultView = "details",
  artwork,
  filters = [],
  onQueryChange,
  total,
}: DenseGridProps<T>) {
  const userId = useContext(CollectionUserContext);
  const filterPanelId = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const preferenceKey = `collection:${testId}`;
  const storageKey = `tantalar.explorer.${userId}.${testId}`;
  const touched = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [localLayout, setLocalLayout] = useState<GridLayout>(() => {
    try { if (userId) return readLayout(JSON.parse(localStorage.getItem(storageKey) ?? "null")) ?? { hiddenColumns: [], density: "dense", view: defaultView }; } catch { /* Storage is optional. */ }
    return { hiddenColumns: [], density: "dense", view: defaultView };
  });
  const [saveError, setSaveError] = useState(false);
  const layout = controlledLayout ?? localLayout;
  const onLayoutChange = (next: GridLayout) => {
    touched.current = true;
    if (controlledChange) { controlledChange(next); return; }
    setLocalLayout(next);
    if (!userId) return;
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Account preferences still persist. */ }
    clearTimeout(saveTimer.current);
    // Keep the last save scheduled when navigating away; serialize resize/layout writes.
    saveTimer.current = setTimeout(() => {
      saveQueue.current = saveQueue.current.catch(() => undefined).then(() => api.saveUiPreferences(userId, { [preferenceKey]: next }))
        .then(() => setSaveError(false)).catch(() => setSaveError(true));
    }, 300);
  };
  useEffect(() => {
    if (!userId || controlledLayout) return;
    let cancelled = false;
    void api.uiPreferences(userId).then(({ preferences }) => {
      const saved = readLayout(preferences[preferenceKey]);
      if (!cancelled && !touched.current) setLocalLayout(saved ?? { hiddenColumns: [], view: defaultView, density: preferences.gridDensity === "comfortable" ? "comfortable" : "dense" });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [userId, preferenceKey, controlledLayout]);
  const sorting = [...(layout.sorting ?? [])].filter(sort => columns.some(column => column.id === sort.id));
  const columnSizing = { ...(layout.columnWidths ?? {}) };
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<{ id: string; value: string }[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const hidden = new Set(layout.hiddenColumns.filter(id => columns.find(c => c.id === id)?.enableHiding !== false));
  if (columns.length && columns.every(c => hidden.has(String(c.id)))) hidden.delete(String(columns[0]!.id));
  const visibleColumns = columns.filter(c => !hidden.has(String(c.id ?? ""))).sort((a, b) => {
    const order = layout.columnOrder ?? [];
    const rank = (id: string) => order.includes(id) ? order.indexOf(id) : columns.findIndex(c => c.id === id) + order.length;
    return rank(String(a.id)) - rank(String(b.id));
  });
  const view = layout.view ?? defaultView;
  const queryChangeRef = useRef(onQueryChange);
  queryChangeRef.current = onQueryChange;
  const queryKey = JSON.stringify({ search: globalFilter, sort: sorting[0]?.id ?? "", desc: sorting[0]?.desc ?? false, page: pagination.pageIndex + 1, pageSize: pagination.pageSize, filters: Object.fromEntries(columnFilters.map(f => [f.id, f.value])) });
  useEffect(() => {
    if (!queryChangeRef.current) return;
    const timer = window.setTimeout(() => queryChangeRef.current?.(JSON.parse(queryKey) as ExplorerQuery), 250);
    return () => window.clearTimeout(timer);
  }, [queryKey]);
  const tableData = useMemo(() => [...data], [data]);
  const table = useReactTable({
    data: tableData,
    autoResetPageIndex: false,
    defaultColumn: { filterFn: (row, id, filter) => {
      const value = row.getValue(id);
      return (Array.isArray(value) ? value : [value]).some(item => String(item).toLowerCase() === String(filter).toLowerCase());
    } },
    columns: [...columns],
    manualFiltering: Boolean(onQueryChange),
    manualSorting: Boolean(onQueryChange),
    manualPagination: Boolean(onQueryChange),
    rowCount: onQueryChange ? total ?? 0 : undefined,
    state: { sorting, globalFilter, columnSizing, columnFilters, columnVisibility: Object.fromEntries([...hidden].map(id => [id, false])), columnOrder: [...(layout.columnOrder ?? [])], ...(paginationEnabled ? { pagination } : {}) },
    onSortingChange: (updater) => {
      onLayoutChange({ ...layout, sorting: functionalUpdate(updater, sorting) });
      setPagination(current => ({ ...current, pageIndex: 0 }));
    },
    onColumnSizingChange: updater => onLayoutChange({ ...layout, columnWidths: functionalUpdate(updater, columnSizing) }),
    columnResizeMode: "onChange",
    onGlobalFilterChange: setGlobalFilter,
    ...(paginationEnabled ? { onPaginationChange: setPagination } : {}),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(paginationEnabled ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    globalFilterFn: "includesString",
  });

  const filteredRowCount = onQueryChange ? total ?? 0 : table.getFilteredRowModel().rows.length;
  useEffect(() => {
    if (!paginationEnabled) return;
    setPagination((current) => {
      const finalPage = Math.max(0, Math.ceil(filteredRowCount / current.pageSize) - 1);
      return current.pageIndex > finalPage ? { ...current, pageIndex: finalPage } : current;
    });
  }, [filteredRowCount, paginationEnabled]);

  useEffect(() => {
    if (!paginationEnabled) return;
    setPagination((current) => current.pageIndex === 0 ? current : { ...current, pageIndex: 0 });
  }, [paginationEnabled, paginationResetKey]);

  const toggleColumn = (id: string) => {
    if (!onLayoutChange || !layout) return;
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else if (visibleColumns.length > 1) next.add(id);
    onLayoutChange({ ...layout, hiddenColumns: [...next] });
  };

  const moveColumn = (id: string, direction: -1 | 1) => {
    if (!onLayoutChange || !layout) return;
    const ids = columns.map((column) => String(column.id ?? "")).filter(Boolean);
    const order = layout.columnOrder?.length ? [...layout.columnOrder] : ids;
    const current = order.indexOf(id);
    const target = current + direction;
    if (current < 0 || target < 0 || target >= order.length) return;
    [order[current], order[target]] = [order[target]!, order[current]!];
    onLayoutChange({ ...layout, columnOrder: order });
  };

  const resetLayout = () => {
    if (!onLayoutChange || !layout) return;

    onLayoutChange({
      view: defaultView,
      hiddenColumns: [],
      density: "dense",
      columnOrder: columns.map((column) => String(column.id ?? "")).filter(Boolean),
      columnWidths: {},
      sorting: [],
    });
  };

  const applyFilter = (id: string, value: string) => {
    setColumnFilters(current => [...current.filter(f => f.id !== id), ...(value ? [{ id, value }] : [])]);
    setPagination(current => ({ ...current, pageIndex: 0 }));
  };
  const renderValue = (cell: Cell<T, unknown>) => {
    if (!cell.column.columnDef.meta?.labelFilter) {
      const value = cell.getValue();
      const field = labelKind(cell.column.id) ? cell.column.id : typeof cell.column.columnDef.header === "string" ? cell.column.columnDef.header : cell.column.id;
      const kind = labelKind(field);
      return kind && (typeof value === "string" || typeof value === "number") && value !== ""
        ? <span className="tantalar-metadata-tag" data-kind={kind}>{metadataLabel(field, value)}</span>
        : flexRender(cell.column.columnDef.cell, cell.getContext());
    }
    const raw = cell.getValue();
    const values = (Array.isArray(raw) ? raw : [raw]).filter(value => value !== null && value !== undefined && value !== "").map(String);
    const label = typeof cell.column.columnDef.header === "string" ? cell.column.columnDef.header : cell.column.id;
    const buttons = (subset: string[]) => subset.map(value => <button type="button" className="tantalar-explorer__label-button" key={value} aria-label={`Filter ${label}: ${metadataLabel(cell.column.id, value)}`} onClick={() => applyFilter(cell.column.id, value)}>{metadataLabel(cell.column.id, value)}</button>);
    return values.length ? <span className="tantalar-explorer__labels">{buttons(values.slice(0, 3))}{values.length > 3 ? <details><summary>{values.length - 3} more</summary>{buttons(values.slice(3))}</details> : null}</span> : "—";
  };
  const renderCell = (cell: Cell<T, unknown>) => view === "details" && artwork && cell.column.id === table.getVisibleLeafColumns()[0]?.id
    ? <div className="tantalar-explorer__table-title"><div>{artwork(cell.row.original)}</div><span>{renderValue(cell)}</span></div>
    : renderValue(cell);
  const hasValue = (cell: Cell<T, unknown>) => Array.isArray(cell.getValue()) ? (cell.getValue() as unknown[]).length > 0 : cell.getValue() != null && cell.getValue() !== "";
  const compact = view !== "details" && view !== "list";
  const renderCompactFields = (cells: Cell<T, unknown>[]) => {
    const fields = cells.filter(cell => cell.column.accessorFn && !cell.column.columnDef.meta?.secondary);
    const [title] = fields;
    const basics = table.getAllLeafColumns().some(column => column.columnDef.meta?.compact)
      ? fields.filter(cell => cell !== title && cell.column.columnDef.meta?.compact)
      : fields.slice(1, 3);
    return <>
      {title ? <div className="tantalar-explorer__field" data-primary>{renderValue(title)}</div> : null}
      <div className="tantalar-explorer__basics">{basics.filter(hasValue).map(cell => <div key={cell.id}>{renderValue(cell)}</div>)}</div>
      {cells.filter(cell => !cell.column.accessorFn).map(cell => <div key={cell.id} className="tantalar-explorer__field" data-action>{renderValue(cell)}</div>)}
    </>;
  };
  const renderFields = (cells: Cell<T, unknown>[]) => cells.filter(cell => !cell.column.accessorFn || hasValue(cell)).map((cell, index) => <div key={cell.id} className="tantalar-explorer__field" data-primary={index === 0 || undefined} data-action={!cell.column.accessorFn || undefined}>
                  {index > 0 && cell.column.accessorFn ? <span className="tantalar-explorer__label">{typeof cell.column.columnDef.header === "string" ? cell.column.columnDef.header : cell.column.id}</span> : null}
                  <div>{renderCell(cell)}</div>
                </div>);
  const padding = layout?.density === "dense" ? "4px 8px" : "8px 12px";
  const leafCount = visibleColumns.length;

  return (
    <Box data-testid={testId} className="tantalar-explorer" data-view={view} data-density={layout.density} aria-busy={loading || undefined}>
      <Group className="tantalar-dense-grid__toolbar" justify="space-between" mb="xs" wrap="wrap">
        <Group gap="xs" wrap="wrap">
          {toolbarStart}
          {searchControl ?? <TextInput
            aria-label={`Filter ${ariaLabel ?? testId}`}
            placeholder="Search…"
            value={globalFilter}
            onChange={(e) => {
              setGlobalFilter(e.currentTarget.value);
              if (paginationEnabled) setPagination((current) => ({ ...current, pageIndex: 0 }));
            }}
            className="tantalar-explorer__search"
          />}
        </Group>
        <Group gap="xs" className="tantalar-explorer__controls">
          {filters.length ? <Button variant="default" aria-expanded={filtersOpen} aria-controls={filterPanelId} leftSection={<IconLine3HorizontalDecrease width={16} height={16} fill="currentColor" aria-hidden="true" />} onClick={() => setFiltersOpen(open => !open)}>Filters{columnFilters.length ? ` (${columnFilters.length})` : ""}</Button> : null}
          <Select aria-label="Sort by" value={sorting[0]?.id ?? ""} data={[{ value: "", label: "Default order" }, ...table.getAllLeafColumns().filter(c => c.getCanSort()).map(c => ({ value: c.id, label: typeof c.columnDef.header === "string" ? c.columnDef.header : c.id }))]} onChange={value => table.setSorting(value ? [{ id: value, desc: sorting[0]?.desc ?? false }] : [])} />
          <Button variant="default" aria-label={sorting[0]?.desc ? "Sort ascending" : "Sort descending"} disabled={!sorting.length} onClick={() => table.setSorting([{ id: sorting[0]!.id, desc: !sorting[0]!.desc }])}>{sorting[0]?.desc ? "↓" : "↑"}</Button>
        {(
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
                    disabled={c.enableHiding === false || (!hidden.has(id) && visibleColumns.length === 1)}
                    onClick={() => toggleColumn(id)}
                    rightSection={hidden.has(id) ? undefined : "✓"}
                  >
                    {typeof c.header === "string" ? c.header : id}
                  </Menu.Item>
                );
              })}
              <Menu.Divider />
              <Menu.Label>Order</Menu.Label>
              {visibleColumns.map((column, index) => {
                const id = String(column.id ?? "");
                return (
                  <Box key={`order-${id}`}>
                    <Menu.Item disabled={index === 0} onClick={() => moveColumn(id, -1)}>Move {id} left</Menu.Item>
                    <Menu.Item disabled={index === visibleColumns.length - 1} onClick={() => moveColumn(id, 1)}>Move {id} right</Menu.Item>
                  </Box>
                );
              })}
              <Menu.Divider />
              <Menu.Item onClick={() => onLayoutChange({ ...layout, density: layout.density === "dense" ? "comfortable" : "dense" })}>
                Density: {layout.density}
              </Menu.Item>
              <Menu.Item color="red" onClick={resetLayout}>Reset layout</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        </Group>
      </Group>
      {filtersOpen && filters.length ? <section id={filterPanelId} aria-label="Collection filters" className="tantalar-explorer__filter-panel">
        <Group justify="space-between"><Text fw={600} size="sm">Filter by</Text><Button variant="subtle" size="compact-xs" onClick={() => setFiltersOpen(false)}>Close filters</Button></Group>
        <div className="tantalar-explorer__filter-fields">
          {filters.map(filter => <Select searchable clearable key={filter.id} label={filter.label} placeholder="All" value={columnFilters.find(f => f.id === filter.id)?.value ?? null} data={filter.options.map(option => ({ ...option, label: labelKind(filter.id) ? metadataLabel(filter.id, option.value) : option.label }))} onChange={value => applyFilter(filter.id, value ?? "")} />)}
        </div>
      </section> : null}
      <Group role="group" aria-label="Layout" className="tantalar-explorer__layouts" gap={4} mb="sm">
        {views.map(({ value, label, icon: Icon }) => <Button key={value} variant="default" size="compact-sm"
          aria-label={`${label} layout`} aria-pressed={view === value}
          leftSection={<Icon width={16} height={16} fill="currentColor" aria-hidden="true" />}
          onClick={() => onLayoutChange({ ...layout, view: value })}>{label}</Button>)}
      </Group>
      {columnFilters.length ? <Group gap="xs" mb="sm" aria-label="Active filters">{columnFilters.map(filter => <button type="button" className="tantalar-explorer__label-button" key={filter.id} aria-label={`Remove ${filters.find(f => f.id === filter.id)?.label ?? filter.id}: ${metadataLabel(filter.id, filter.value)} filter`} onClick={() => applyFilter(filter.id, "")}>{filters.find(f => f.id === filter.id)?.label ?? filter.id}: {metadataLabel(filter.id, filter.value)} ×</button>)}<Button size="compact-xs" variant="subtle" onClick={() => { setColumnFilters([]); setPagination(current => ({ ...current, pageIndex: 0 })); }}>Clear filters</Button></Group> : null}
      <ActionNotice message={saveError ? "Account preference sync failed. Layout is saved on this device." : null} title="Layout saved locally" severity="warning" />
      {view !== "details" ? (
        <div className="tantalar-explorer__items" role="list" aria-label={ariaLabel ?? testId}>
          {loading && !data.length ? Array.from({ length: LOADING_ROWS }, (_, i) => <Skeleton key={i} height={80} />) : table.getRowModel().rows.length === 0 ? <Text c="dimmed">{emptyMessage ?? "Nothing to show."}</Text> : table.getRowModel().rows.map(row => (
            <article data-testid={rowTestId?.(row.original)} key={row.id} role="listitem" className="tantalar-explorer__item" data-selected={isRowSelected?.(row.original) || undefined}>
              {artwork ? <div className="tantalar-explorer__artwork">{artwork(row.original)}</div> : null}
              <div className="tantalar-explorer__fields">
                {compact ? renderCompactFields(row.getAllCells().filter(cell => cell.column.getIsVisible())) : renderFields(row.getVisibleCells().filter(cell => !cell.column.columnDef.meta?.secondary))}
                {!compact && row.getVisibleCells().some(cell => cell.column.columnDef.meta?.secondary && hasValue(cell)) ? <details className="tantalar-explorer__more"><summary>More details</summary>{renderFields(row.getVisibleCells().filter(cell => cell.column.columnDef.meta?.secondary))}</details> : null}
                {onRowActivate ? <Button variant="subtle" aria-pressed={isRowSelected?.(row.original)} onClick={() => onRowActivate(row.original)}>{rowAriaLabel?.(row.original) ?? "Open"}</Button> : null}
              </div>
            </article>
          ))}
        </div>
      ) : <Table.ScrollContainer minWidth={400}>
        <Table
          highlightOnHover
          captionSide="top"
          className={layout?.density === "dense" ? "tantalar-grid-table tantalar-grid-dense" : "tantalar-grid-table"}
          aria-label={ariaLabel ?? testId}
          style={{ minWidth: table.getTotalSize(), tableLayout: "fixed" }}
        >
          <Table.Thead>
            {table.getHeaderGroups().map((hg) => (
              <Table.Tr key={hg.id}>
                {hg.headers.map((h) => (
                  <Table.Th
                    key={h.id}
                    className={h.column.columnDef.meta?.dataType ? "tantalar-tabular" : undefined}
                    aria-sort={
                      h.column.getIsSorted() === "asc"
                        ? "ascending"
                        : h.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                    style={{ cursor: h.column.getCanSort() && !loading ? "pointer" : undefined, padding, width: h.getSize(), position: "relative" }}
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
                    {h.column.getCanResize() ? (
                      <button
                        type="button"
                        className="tantalar-grid-resizer"
                        aria-label={`Resize ${String(h.column.columnDef.header ?? h.column.id)} column`}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => { event.stopPropagation(); h.column.resetSize(); }}
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          event.stopPropagation();
                          table.setColumnSizing((current) => ({
                            ...current,
                            [h.column.id]: Math.max(48, h.column.getSize() + (event.key === "ArrowRight" ? 16 : -16)),
                          }));
                        }}
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                      />
                    ) : null}
                  </Table.Th>
                ))}
              </Table.Tr>
            ))}
          </Table.Thead>
          <Table.Tbody className={loading && !data.length ? "tantalar-grid-loading" : undefined}>
            {loading && !data.length ? (
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
                <Table.Tr
                  key={row.id}
                  data-testid={rowTestId?.(row.original)}
                  className={onRowActivate ? "tantalar-grid-row-action" : undefined}
                  data-selected={isRowSelected?.(row.original) || undefined}
                  aria-selected={isRowSelected ? Boolean(isRowSelected(row.original)) : undefined}
                  aria-label={rowAriaLabel?.(row.original)}
                  tabIndex={onRowActivate ? 0 : undefined}
                  onClick={onRowActivate ? event => { if (!(event.target as HTMLElement).closest("button,a,input,select,textarea,summary")) onRowActivate(row.original); } : undefined}
                  onKeyDown={onRowActivate ? (event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onRowActivate(row.original);
                    }
                  } : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <Table.Td
                      key={cell.id}
                      className={cell.column.columnDef.meta?.dataType ? "tantalar-tabular" : undefined}
                      style={{ padding, width: cell.column.getSize() }}
                    >
                      {renderCell(cell)}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>}
      {paginationEnabled ? (
        <Group justify="space-between" mt="xs" wrap="wrap" aria-label={`${ariaLabel ?? testId} pagination`}>
          <Group gap="xs">
            <NativeSelect
              aria-label="Rows per page"
              value={String(pagination.pageSize)}
              data={["25", "50", "100"]}
              onChange={(event) => {
                table.setPageSize(Number(event.currentTarget.value));
                table.setPageIndex(0);
              }}
              w={84}
            />
            <Text size="xs" c="dimmed">rows per page</Text>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed" aria-live="polite">
              {filteredRowCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1}–{Math.min(
                (pagination.pageIndex + 1) * pagination.pageSize,
                filteredRowCount,
              )} of {filteredRowCount}
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              Previous
            </Button>
            <Button
              size="compact-xs"
              variant="default"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              Next
            </Button>
          </Group>
        </Group>
      ) : null}
    </Box>
  );
}

import React, { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ColumnDef } from "@tanstack/react-table";
import { DenseGrid, CollectionUserContext, type GridLayout } from "../src/admin/DenseGrid";
import { api } from "../src/api";
import { metadataLabel } from "../src/state-label";

const layoutLabels: Record<string, string> = { details: "Details", list: "List", columns: "Two columns", small: "Small tiles", medium: "Medium tiles", large: "Large tiles" };

interface RecordRow {
  id: number;
  name: string;
}

const columns: ReadonlyArray<ColumnDef<RecordRow, unknown>> = [
  { id: "id", header: "ID", accessorKey: "id", meta: { dataType: "number" } },
  { id: "name", header: "Name", accessorKey: "name" },
];

const rows = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, name: `Record ${index + 1}` }));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Grid({ data = rows, resetKey = "all" }: { data?: readonly RecordRow[]; resetKey?: string }) {
  return (
    <MantineProvider>
      <DenseGrid
        columns={columns}
        data={data}
        testId="records-grid"
        ariaLabel="records"
        pagination
        paginationResetKey={resetKey}
      />
    </MantineProvider>
  );
}

function CustomizableGrid() {
  const [layout, setLayout] = useState<GridLayout>({
    hiddenColumns: [],
    density: "dense",
    columnOrder: ["id", "name"],
  });
  return (
    <MantineProvider>
      <DenseGrid
        columns={columns}
        data={rows.slice(0, 3)}
        testId="custom-grid"
        ariaLabel="custom records"
        layout={layout}
        onLayoutChange={setLayout}
      />
    </MantineProvider>
  );
}

describe("DenseGrid opt-in pagination", () => {
  it("normalizes labels and keeps raw filter values in a panel outside the toolbar", () => {
    expect(["film", "movie", "tv", "tv_show"].map(value => metadataLabel("kind", value))).toEqual(["Movie", "Movie", "Series", "Series"]);
    expect(["uhd", "full_hd", "1080P"].map(value => metadataLabel("quality", value))).toEqual(["UHD", "Full HD", "1080p"]);
    expect(metadataLabel("state", "awaiting_import")).toBe("Awaiting import");
    render(<MantineProvider><DenseGrid testId="normalized" data={[{ title: "Movie one", kind: "film", quality: "uhd", state: "awaiting_import" }, { title: "Series two", kind: "tv", quality: "hd", state: "available" }]} columns={[
      { id: "title", header: "Title", accessorKey: "title" },
      { id: "kind", header: "Type", accessorKey: "kind", meta: { labelFilter: true } },
      { id: "quality", header: "Quality", accessorKey: "quality", meta: { labelFilter: true } },
      { id: "state", header: "State", accessorKey: "state" },
    ]} filters={[{ id: "kind", label: "Type", options: [{ value: "film", label: "film" }, { value: "tv", label: "tv" }] }]} /></MantineProvider>);
    const toggle = screen.getByRole("button", { name: "Filters", exact: true });
    fireEvent.click(toggle);
    const panel = screen.getByRole("region", { name: "Collection filters" });
    expect(panel.closest(".tantalar-dense-grid__toolbar")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Awaiting import").classList.contains("tantalar-metadata-tag")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Filter Type: Movie" }));
    expect(screen.getByText("Movie one")).toBeTruthy();
    expect(screen.queryByText("Series two")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter Quality: UHD" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.queryByRole("region", { name: "Collection filters" })).toBeNull();
    expect(screen.getByText("Movie one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Series two")).toBeTruthy();
  });
  it("keeps artwork, titles, basic labels and actions in compact views, with full metadata in list and details", () => {
    render(<MantineProvider><DenseGrid testId="compact-media" data={[{ title: "Observatory", year: 2026, rating: 7.5, actor: "Sam Lee" }]} artwork={row => <img alt={`${row.title} poster`} />} columns={[
      { id: "title", header: "Title", accessorKey: "title" },
      { id: "year", header: "Year", accessorKey: "year", meta: { compact: true, labelFilter: true } },
      { id: "rating", header: "Rating", accessorKey: "rating" },
      { id: "actor", header: "Actor", accessorKey: "actor", meta: { secondary: true } },
      { id: "actions", header: "Actions", cell: () => <button>Edit</button> },
    ]} /></MantineProvider>);
    for (const value of ["columns", "small", "medium", "large"]) {
      fireEvent.click(screen.getByRole("button", { name: `${layoutLabels[value]} layout` }));
      expect(screen.getByRole("img", { name: "Observatory poster" })).toBeTruthy();
      expect(screen.getByText("Observatory")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Filter Year: 2026" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      expect(screen.queryByText("7.5")).toBeNull();
      expect(screen.queryByText("Sam Lee")).toBeNull();
      expect(screen.queryByText("More details")).toBeNull();
    }
    for (const value of ["list", "details"]) {
      fireEvent.click(screen.getByRole("button", { name: `${layoutLabels[value]} layout` }));
      expect(screen.getByText("7.5")).toBeTruthy();
      expect(screen.getByText("Sam Lee")).toBeTruthy();
    }
  });

  it("keeps matching rows and actions across every layout, including hidden label columns", async () => {
    const open = vi.fn(), activate = vi.fn();
    render(<MantineProvider><DenseGrid testId="explorer" ariaLabel="labels" data={rows.slice(0, 3)} onRowActivate={activate} columns={[
      { id: "name", header: "Name", accessorKey: "name" },
      { id: "id", header: "ID", accessorKey: "id", meta: { labelFilter: true } },
      { id: "actions", header: "Actions", enableHiding: false, cell: ({ row }) => <button onClick={() => open(row.original.id)}>Play</button> },
    ]} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Filter ID: 2" }));
    expect(screen.getByText("1–1 of 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^ID/ }));
    for (const value of ["list", "columns", "small", "medium", "large", "details"]) {
      fireEvent.click(screen.getByRole("button", { name: `${layoutLabels[value]} layout` }));
      expect(screen.queryByText("Record 1")).toBeNull();
      expect(screen.getByText("Record 2")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    }
    expect(open).toHaveBeenCalledTimes(6);
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("1–3 of 3")).toBeTruthy();
  });

  it("loads per-user collection preferences and saves the last change after navigation", async () => {
    vi.spyOn(api, "uiPreferences").mockResolvedValue({ preferences: { "collection:one": { hiddenColumns: [], density: "dense", view: "large", sorting: [{ id: "id", desc: true }] } } });
    const save = vi.spyOn(api, "saveUiPreferences").mockResolvedValue({ saved: true });
    const mounted = render(<MantineProvider><CollectionUserContext.Provider value="viewer-1"><DenseGrid columns={columns} data={rows.slice(0, 3)} testId="one" /></CollectionUserContext.Provider></MantineProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Large tiles layout" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Two columns layout" }));
    mounted.unmount();
    await waitFor(() => expect(save).toHaveBeenCalledWith("viewer-1", { "collection:one": expect.objectContaining({ view: "columns" }) }));
    render(<MantineProvider><CollectionUserContext.Provider value="viewer-1"><DenseGrid columns={columns} data={rows.slice(0, 3)} testId="two" /></CollectionUserContext.Provider></MantineProvider>);
    expect(screen.getByRole("button", { name: "Details layout" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("uses tabular figures for declared number and time columns", () => {
    render(<Grid data={rows.slice(0, 1)} />);
    expect(screen.getByRole("columnheader", { name: "ID" }).classList.contains("tantalar-tabular")).toBe(true);
    expect(screen.getAllByRole("cell")[0]?.classList.contains("tantalar-tabular")).toBe(true);
    expect(screen.getByRole("columnheader", { name: "Name" }).classList.contains("tantalar-tabular")).toBe(false);
  });

  it("activates and marks a selectable full row without an action column", () => {
    const activate = vi.fn();
    render(
      <MantineProvider>
        <DenseGrid
          columns={columns}
          data={rows.slice(0, 3)}
          testId="selectable-grid"
          ariaLabel="selectable records"
          onRowActivate={activate}
          isRowSelected={(row) => row.id === 2}
          rowAriaLabel={(row) => `Inspect ${row.name}`}
        />
      </MantineProvider>,
    );
    const row = screen.getByRole("row", { name: "Inspect Record 2" });
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith(rows[1]);
  });

  it("pages filtered rows and offers 25/50/100 row sizes", async () => {
    render(<Grid />);
    expect(screen.getByText("1–25 of 60")).toBeTruthy();
    expect(screen.getByText("Record 25")).toBeTruthy();
    expect(screen.queryByText("Record 26")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("26–50 of 60")).toBeTruthy();
    expect(screen.getByText("Record 26")).toBeTruthy();
    expect(screen.queryByText("Record 25")).toBeNull();

    const pageSize = screen.getByRole("combobox", { name: "Rows per page" });
    expect(Array.from((pageSize as HTMLSelectElement).options).map((option) => option.value)).toEqual(["25", "50", "100"]);
    fireEvent.change(pageSize, { target: { value: "50" } });
    expect(screen.getByText("1–50 of 60")).toBeTruthy();
  });

  it("resets for text/external filters and clamps when data shrinks", async () => {
    const view = render(<Grid />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("51–60 of 60")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter records" }), { target: { value: "Record 1" } });
    expect(screen.getByText("1–11 of 11")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByRole("textbox", { name: "Filter records" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    view.rerender(<Grid data={rows.slice(0, 3)} resetKey="smaller" />);
    await waitFor(() => expect(screen.getByText("1–3 of 3")).toBeTruthy());
  });

  it("lets operators hide, reorder, resize, and reset columns", async () => {
    render(<CustomizableGrid />);
    const idResizer = screen.getByRole("button", { name: "Resize ID column" });
    expect(idResizer).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resize Name column" })).toBeTruthy();
    const initialWidth = idResizer.closest("th")?.style.width;
    fireEvent.keyDown(idResizer, { key: "ArrowRight" });
    expect(idResizer.closest("th")?.style.width).not.toBe(initialWidth);

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(await screen.findByText("Name", { exact: true, selector: "button *" }));
    expect(screen.queryByText("Record 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(await screen.findByText("Reset layout", { exact: true }));
    expect(screen.getByText("Record 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(await screen.findByText("Move name left", { exact: true }));
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent?.trim());
    expect(headers[0]).toContain("Name");
  });
});

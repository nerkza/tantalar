import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("../src/shell/HealthViews", () => ({
  OverviewDashboard: () => <div><h1>Overview</h1>System status dashboard</div>,
  SystemHealthDashboard: () => <div>System health dashboard</div>,
}));

import {
  ControlNavigation,
  ControlPage,
  type ControlArea,
  type ControlChild,
} from "../src/shell/ControlSurface";

const productCss = readFileSync(resolve(process.cwd(), "src/product.css"), "utf8");

let productStyles: HTMLStyleElement;

beforeAll(() => {
  productStyles = document.createElement("style");
  productStyles.textContent = productCss;
  document.head.append(productStyles);
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
});

afterAll(() => productStyles.remove());
afterEach(() => cleanup());

function NavigationHarness({ initialArea = "overview", initialChild }: { initialArea?: ControlArea; initialChild?: ControlChild }) {
  const [route, setRoute] = useState<{ area: ControlArea; child?: ControlChild }>({
    area: initialArea,
    ...(initialChild ? { child: initialChild } : {}),
  });
  return (
    <MantineProvider>
      <ControlNavigation
        area={route.area}
        child={route.child}
        onNavigate={(area, child) => setRoute({ area, ...(child ? { child } : {}) })}
      />
      <output data-testid="route">{route.area}/{route.child ?? "root"}</output>
    </MantineProvider>
  );
}

describe("Control navigation disclosures", () => {
  it("opens an inactive group at its canonical default and lets the active group collapse", () => {
    render(<NavigationHarness />);
    const acquisition = screen.getByTestId("control-nav-acquisition");
    const acquisitionChildren = document.getElementById("control-nav-acquisition-children")!;
    expect(productCss).toMatch(/\.tantalar-nav-children\[hidden\]\s*\{[^}]*display:\s*none/);
    expect(acquisition.getAttribute("aria-expanded")).toBe("false");
    expect(acquisitionChildren.hidden).toBe(true);
    expect(getComputedStyle(acquisitionChildren).display).toBe("none");
    expect(screen.queryByRole("button", { name: "Indexers" })).toBeNull();

    fireEvent.click(acquisition);
    expect(screen.getByTestId("route").textContent).toBe("acquisition/indexers");
    expect(acquisition.getAttribute("aria-expanded")).toBe("true");
    expect(acquisitionChildren.hidden).toBe(false);
    expect(getComputedStyle(acquisitionChildren).display).not.toBe("none");
    expect(screen.getByRole("button", { name: "Indexers" })).toBeTruthy();
    expect(screen.getByTestId("control-nav-acquisition-indexers").getAttribute("aria-current")).toBe("page");

    const routeBeforeCollapse = screen.getByTestId("route").textContent;
    fireEvent.click(acquisition);
    expect(acquisition.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("route").textContent).toBe(routeBeforeCollapse);
    expect(acquisitionChildren.hidden).toBe(true);
    expect(getComputedStyle(acquisitionChildren).display).toBe("none");
    expect(screen.queryByRole("button", { name: "Indexers" })).toBeNull();
  });

  it("opens and selects a deep-linked child", () => {
    render(<NavigationHarness initialArea="audit" initialChild="trace" />);
    expect(screen.getByTestId("control-nav-audit").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("control-nav-audit-trace").getAttribute("aria-current")).toBe("page");
  });
});

describe("Control overview", () => {
  it("uses the shared page heading without a duplicate hero", () => {
    render(
      <MantineProvider>
        <ControlPage area="overview" adminId="admin-1" onNavigate={() => undefined} />
      </MantineProvider>,
    );
    expect(screen.getAllByRole("heading", { name: "Overview" })).toHaveLength(1);
    expect(screen.queryByText("Administration console")).toBeNull();
    expect(screen.queryByText("Configure the server without leaving the product")).toBeNull();
    expect(screen.getByText("System status dashboard")).toBeTruthy();
  });
});

import { vi } from "vitest";
// jsdom has no layout engine; Mantine observes element sizes in browsers.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

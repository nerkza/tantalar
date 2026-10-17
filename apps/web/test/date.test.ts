import { describe, expect, it } from "vitest";
import { formatDateTime, formatShortDate } from "../src/date";

describe("date formatting", () => {
  it("uses consistent operator-facing formats and handles invalid values", () => {
    const value = "2026-08-26T10:15:30.000Z";
    expect(formatShortDate(value)).toContain("2026");
    expect(formatShortDate(value)).not.toBe("2026-08-26");
    expect(formatDateTime(value)).toContain("2026");
    expect(formatDateTime("invalid")).toBe("—");
  });
});

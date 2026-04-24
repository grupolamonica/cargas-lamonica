import { describe, expect, it } from "vitest";
import { calculateEstimatedTimeInMinutes, formatEstimatedTime } from "@/lib/estimated-time";

describe("estimated time", () => {
  it("applies the two-hour loading offset before calculating the duration", () => {
    expect(
      calculateEstimatedTimeInMinutes(
        "2026-04-04T08:00:00-03:00",
        "2026-04-04T18:00:00-03:00",
      ),
    ).toBe(480);
  });

  it("formats shorter trips with hours and minutes", () => {
    expect(
      formatEstimatedTime(
        "2026-04-04T08:00:00-03:00",
        "2026-04-04T12:30:00-03:00",
      ),
    ).toBe("2h 30min");
  });

  it("formats longer trips with days and hours", () => {
    expect(
      formatEstimatedTime(
        "2026-04-04T08:00:00-03:00",
        "2026-04-05T14:30:00-03:00",
      ),
    ).toBe("1d 4h");
  });

  it("clamps negative results to zero", () => {
    expect(
      formatEstimatedTime(
        "2026-04-04T08:00:00-03:00",
        "2026-04-04T09:30:00-03:00",
      ),
    ).toBe("0h");
  });

  it("returns a fallback label when one of the dates is invalid", () => {
    expect(
      formatEstimatedTime(
        "invalid-date",
        "2026-04-04T18:00:00-03:00",
      ),
    ).toBe("Indisponivel");
  });
});

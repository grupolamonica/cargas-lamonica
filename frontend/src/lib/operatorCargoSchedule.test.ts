import { describe, expect, it } from "vitest";

import { normalizeOperatorCargoDate, normalizeOperatorCargoTime } from "@/lib/operatorCargoSchedule";

describe("operatorCargoSchedule", () => {
  it("keeps already normalized values", () => {
    expect(normalizeOperatorCargoDate("2026-04-13")).toBe("2026-04-13");
    expect(normalizeOperatorCargoTime("17:30")).toBe("17:30");
    expect(normalizeOperatorCargoTime("17:30:00")).toBe("17:30");
  });

  it("extracts date and time from ISO-like values used by the operator read model", () => {
    expect(normalizeOperatorCargoDate("2026-04-08T03:00:00.000Z")).toBe("2026-04-08");
    expect(normalizeOperatorCargoTime("2026-04-08T17:00:00.000Z")).toBe("17:00");
  });

  it("uses the fallback when the schedule is empty or invalid", () => {
    expect(normalizeOperatorCargoDate("", "2026-04-13")).toBe("2026-04-13");
    expect(normalizeOperatorCargoDate("invalid-date", "2026-04-13")).toBe("2026-04-13");
    expect(normalizeOperatorCargoTime("", "09:45")).toBe("09:45");
    expect(normalizeOperatorCargoTime("invalid-time", "09:45")).toBe("09:45");
  });
});

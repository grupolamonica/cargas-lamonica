import { describe, expect, it } from "vitest";

import { calculateOperationalEtaHours, calculateOperationalEtaMinutes } from "./operational-eta.js";

describe("operational eta", () => {
  it("calculates unloading minus loading plus two hours", () => {
    expect(calculateOperationalEtaMinutes("07/04/2026 11:00", "10/04/2026 10:00")).toBe(4140);
    expect(calculateOperationalEtaHours("07/04/2026 11:00", "10/04/2026 10:00")).toBe(69);
  });

  it("falls back to the direct interval when the loading offset would zero the window", () => {
    expect(calculateOperationalEtaMinutes("07/04/2026 11:00", "07/04/2026 12:00")).toBe(60);
    expect(calculateOperationalEtaHours("07/04/2026 11:00", "07/04/2026 12:00")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(calculateOperationalEtaMinutes("invalido", null)).toBeNull();
    expect(calculateOperationalEtaHours("invalido", null)).toBeNull();
  });
});

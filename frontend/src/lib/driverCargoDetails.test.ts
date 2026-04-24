import { describe, expect, it } from "vitest";

import {
  getVisibleDriverCargoRequirementLabels,
  hasVisibleDriverCargoClientNotes,
} from "@/lib/driverCargoDetails";

describe("driverCargoDetails", () => {
  it("returns only active client requirements", () => {
    expect(
      getVisibleDriverCargoRequirementLabels({
        exige_rastreamento: true,
        exige_antt: false,
        exige_seguro: true,
        exige_carga_monitorada: false,
      }),
    ).toEqual(["Rastreamento", "Seguro"]);
  });

  it("treats blank client notes as hidden", () => {
    expect(hasVisibleDriverCargoClientNotes("   ")).toBe(false);
    expect(hasVisibleDriverCargoClientNotes(null)).toBe(false);
    expect(hasVisibleDriverCargoClientNotes("Chegar com antecedencia de 1h")).toBe(true);
  });
});

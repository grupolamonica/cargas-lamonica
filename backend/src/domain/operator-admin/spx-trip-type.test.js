import { describe, it, expect } from "vitest";
import { classifySpxTripType, isForecastTripName } from "./spx-trip-type.js";

describe("classifySpxTripType", () => {
  it("classifica Forecast pelo naming F<slot> (F0_/F1_…)", () => {
    expect(classifySpxTripType("20260802F0_125_4199_21:00_22:00_HUB_AM01")).toBe("forecast");
    expect(classifySpxTripType("20260726F1_181_5410_18:00_19:00_HUB_AM01")).toBe("forecast");
    expect(isForecastTripName("20260802F0_125_4199_21:00_22:00_HUB_AM01")).toBe(true);
  });

  it("classifica Adhoc (spot) mesmo começando após a data", () => {
    expect(classifySpxTripType("20260728Adhoc-S0217519HAM0501")).toBe("adhoc");
    expect(isForecastTripName("20260728Adhoc-S0217519HAM0501")).toBe(false);
  });

  it("classifica FM Hub (F + letra, não confunde com Forecast)", () => {
    expect(classifySpxTripType("20260731FM Hub_3PL_SP_Pedreira_01-2601")).toBe("fm-hub");
    expect(isForecastTripName("20260731FM Hub_3PL_SP_São Paulo-02-0601")).toBe(false);
  });

  it("nome vazio/nulo/desconhecido → outros (nunca forecast)", () => {
    expect(classifySpxTripType("")).toBe("outros");
    expect(classifySpxTripType(null)).toBe("outros");
    expect(classifySpxTripType(undefined)).toBe("outros");
    expect(classifySpxTripType("20260728XPTO_lane_99")).toBe("outros");
    expect(isForecastTripName("")).toBe(false);
  });

  it("é tolerante a nome sem prefixo de data", () => {
    expect(classifySpxTripType("F0_125_4199")).toBe("forecast");
    expect(classifySpxTripType("Adhoc-123")).toBe("adhoc");
  });
});

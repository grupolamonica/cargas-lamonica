import { describe, expect, it } from "vitest";

import { isOnlineSheetCargo } from "./cargoOnlineSheet";

describe("isOnlineSheetCargo", () => {
  it("carga sincronizada da planilha Shopee (sheet_lh + sheet_synced_at) → true", () => {
    expect(
      isOnlineSheetCargo({ sheet_lh: "LH-001", sheet_synced_at: "2026-07-09T12:00:00.000Z" }),
    ).toBe(true);
  });

  it("carga importada via CSV (sheet_lh, sem sheet_synced_at) → false", () => {
    expect(isOnlineSheetCargo({ sheet_lh: "COD-123", sheet_synced_at: null })).toBe(false);
    expect(isOnlineSheetCargo({ sheet_lh: "COD-123" })).toBe(false);
  });

  it("carga do sistema (sem sheet_lh) → false", () => {
    expect(isOnlineSheetCargo({ sheet_lh: null, sheet_synced_at: null })).toBe(false);
    expect(isOnlineSheetCargo(null)).toBe(false);
    expect(isOnlineSheetCargo(undefined)).toBe(false);
  });

  it("strings em branco não contam como preenchidas → false", () => {
    expect(isOnlineSheetCargo({ sheet_lh: "   ", sheet_synced_at: "2026-07-09T12:00:00.000Z" })).toBe(false);
    expect(isOnlineSheetCargo({ sheet_lh: "LH-001", sheet_synced_at: "   " })).toBe(false);
  });
});

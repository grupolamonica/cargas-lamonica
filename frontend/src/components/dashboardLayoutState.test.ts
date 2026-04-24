import { describe, expect, it } from "vitest";

import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DESKTOP_SHIFT,
  SIDEBAR_EXPANDED_WIDTH,
  getDashboardContentInset,
} from "./dashboardLayoutState";

describe("dashboardLayoutState", () => {
  it("exposes the expected desktop sidebar dimensions", () => {
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(104);
    expect(SIDEBAR_EXPANDED_WIDTH).toBe(340);
    expect(SIDEBAR_DESKTOP_SHIFT).toBe(236);
  });

  it("keeps the compact sidebar inset on mobile and when collapsed", () => {
    expect(getDashboardContentInset({ isMobile: true, collapsed: false })).toBe(104);
    expect(getDashboardContentInset({ isMobile: false, collapsed: true })).toBe(104);
  });

  it("reserves the expanded sidebar width when the menu opens on desktop", () => {
    expect(getDashboardContentInset({ isMobile: false, collapsed: false })).toBe(340);
  });
});

import {
  DASHBOARD_SIDEBAR_COLLAPSED_WIDTH as SIDEBAR_COLLAPSED_WIDTH,
  DASHBOARD_SIDEBAR_EXPANDED_SHIFT as SIDEBAR_DESKTOP_SHIFT,
  DASHBOARD_SIDEBAR_EXPANDED_WIDTH as SIDEBAR_EXPANDED_WIDTH,
} from "./dashboard-shell";

export { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_DESKTOP_SHIFT, SIDEBAR_EXPANDED_WIDTH };

interface DashboardContentInsetInput {
  isMobile: boolean;
  collapsed: boolean;
}

export function getDashboardContentInset({ isMobile, collapsed }: DashboardContentInsetInput) {
  if (isMobile || collapsed) {
    return SIDEBAR_COLLAPSED_WIDTH;
  }

  return SIDEBAR_EXPANDED_WIDTH;
}

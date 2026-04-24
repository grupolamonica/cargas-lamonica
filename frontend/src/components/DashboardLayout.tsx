import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { useIsMobile } from "@/hooks/use-mobile";

import DashboardSidebar from "./DashboardSidebar";
import { getDashboardContentInset } from "./dashboardLayoutState";

const SIDEBAR_STORAGE_KEY = "lamonica-admin-sidebar-collapsed";

function getInitialSidebarState() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

const DashboardOutlet = () => <Outlet />;

const DashboardLayout = () => {
  const [collapsed, setCollapsed] = useState(getInitialSidebarState);
  const isMobile = useIsMobile();
  const effectiveCollapsed = isMobile ? true : collapsed;
  const contentInset = getDashboardContentInset({
    isMobile,
    collapsed: effectiveCollapsed,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <div className="admin-theme min-h-screen bg-background">
      <div className="admin-page-shell relative flex min-h-screen w-full overflow-x-clip">
        <DashboardSidebar
          collapsed={effectiveCollapsed}
          onToggle={() => {
            if (!isMobile) {
              setCollapsed((current) => !current);
            }
          }}
        />

        <div
          aria-hidden="true"
          className="shrink-0"
          data-testid="dashboard-sidebar-spacer"
          style={{ width: contentInset }}
        />

        <div
          className="relative min-h-screen min-w-0 flex-1 overflow-visible"
          id="main-content-shell"
        >
          <div className="relative min-h-screen min-w-0 max-w-full" id="main-content">
            <DashboardOutlet />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardLayout;

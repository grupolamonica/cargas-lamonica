import { memo } from "react";
import {
  Bell,
  Building2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  Link2,
  LogOut,
  Moon,
  Route,
  Package,
  Sun,
  Truck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useTheme } from "next-themes";

import lamonicaLogo from "@/assets/lamonica-logo.png";
import { useAuth } from "@/hooks/useAuth";
import { getOperatorAccessLevel } from "@/lib/operatorAccess";
import { getOperatorDisplayName, getOperatorInitials } from "@/lib/operatorIdentity";
import { cn } from "@/lib/utils";

import {
  DASHBOARD_SIDEBAR_COLLAPSED_PANEL_WIDTH,
  DASHBOARD_SIDEBAR_EXPANDED_PANEL_WIDTH,
  DASHBOARD_SIDEBAR_EXPANDED_WIDTH,
} from "./dashboard-shell";

/* ─────────────────────────── Types ─────────────────────────── */

interface DashboardSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface NavigationItem {
  icon: LucideIcon;
  label: string;
  path: string;
  requiredAccessLevel?: "advanced";
}

/* ─────────────────────────── Data ──────────────────────────── */

const navigationItems: NavigationItem[] = [
  { icon: LayoutDashboard, label: "Painel", path: "/painel" },
  { icon: Building2, label: "Clientes", path: "/clientes" },
  { icon: Package, label: "Cargas", path: "/cargas" },
  { icon: Route, label: "Rotas", path: "/rotas" },
  { icon: Link2, label: "Links", path: "/operador" },
  { icon: Bell, label: "Fila", path: "/leads" },
  { icon: History, label: "Hist\u00f3rico fila", path: "/historico-fila" },
  { icon: UsersRound, label: "Motoristas", path: "/motoristas" },
  { icon: Truck, label: "Veiculos", path: "/veiculos" },
  { icon: FileSpreadsheet, label: "Monitor", path: "/planilha" },
  { icon: ClipboardList, label: "Auditoria", path: "/auditoria", requiredAccessLevel: "advanced" },
];

/* ─────────────────────────── Helpers ───────────────────────── */

const isRouteActive = (pathname: string, path: string) => {
  if (path === "/") return pathname === "/";
  return pathname.startsWith(path);
};

const panelTransition = {
  transitionDuration: "220ms",
  transitionTimingFunction: "cubic-bezier(0.2, 0.9, 0.25, 1)",
} as const;

const iconBtnClass =
  "flex h-9 w-9 items-center justify-center rounded-xl text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-white";

const scrollAreaClass =
  "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(0,0,0,0.08)_transparent] dark:[scrollbar-color:rgba(255,255,255,0.08)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/[0.06] dark:[&::-webkit-scrollbar-thumb]:bg-white/[0.08]";

/* ─────────────────────────── Component ─────────────────────── */

const DashboardSidebar = memo(({ collapsed, onToggle }: DashboardSidebarProps) => {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const operatorName = getOperatorDisplayName(user?.email);
  const operatorInitials = getOperatorInitials(operatorName);
  const accessLevel = getOperatorAccessLevel(user);
  const visibleNavigationItems = navigationItems.filter(
    (item) => !item.requiredAccessLevel || accessLevel === item.requiredAccessLevel,
  );
  const panelWidth = collapsed ? DASHBOARD_SIDEBAR_COLLAPSED_PANEL_WIDTH : DASHBOARD_SIDEBAR_EXPANDED_PANEL_WIDTH;

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <aside
      className="pointer-events-none fixed left-0 top-0 z-40 h-[100dvh] overflow-visible"
      style={{ width: DASHBOARD_SIDEBAR_EXPANDED_WIDTH }}
    >
      <div
        className="pointer-events-auto absolute inset-y-3 left-3 flex flex-col overflow-hidden rounded-3xl border border-gray-200/60 bg-white shadow-[0_4px_28px_rgba(0,0,0,0.06)] transition-[width] motion-reduce:transition-none dark:border-white/[0.06] dark:bg-[#0b1120] dark:shadow-[0_4px_28px_rgba(0,0,0,0.35)]"
        style={{ width: panelWidth, contain: "layout paint", ...panelTransition }}
      >
        {/* ─── Header: Logo + Branding ─── */}
        <div className={cn("shrink-0", collapsed ? "px-3 py-4" : "px-5 py-5")}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 dark:bg-white/[0.06]">
                <img src={lamonicaLogo} alt="Lamonica" className="h-9 w-9 object-contain" />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3.5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gray-50 dark:bg-white/[0.06]">
                <img src={lamonicaLogo} alt="Lamonica" className="h-9 w-9 object-contain" />
              </div>
              <div className="min-w-0">
                <p className="text-[0.58rem] font-bold uppercase tracking-[0.22em] text-gray-400 dark:text-gray-500">
                  Painel do operador
                </p>
                <p className="mt-0.5 text-[1.05rem] font-bold tracking-tight text-gray-900 dark:text-white">
                  Lamonica
                </p>
                <p className="mt-0.5 text-[0.72rem] text-gray-500 dark:text-gray-400">
                  Acesso rapido
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ─── Divider ─── */}
        <div className={cn("h-px bg-gray-100 dark:bg-white/[0.06]", collapsed ? "mx-3" : "mx-5")} />

        {/* ─── Navigation ─── */}
        <div className={cn(scrollAreaClass, collapsed ? "px-2.5 py-3" : "px-3 py-4")}>
          {!collapsed && (
            <div className="mb-3 flex items-center justify-between px-2">
              <p className="text-[0.58rem] font-bold uppercase tracking-[0.22em] text-gray-400 dark:text-gray-500">
                Navegacao
              </p>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[0.58rem] font-bold text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                {navigationItems.length} atalhos
              </span>
            </div>
          )}

          <nav className={cn("space-y-1", collapsed && "space-y-1.5")}>
            {visibleNavigationItems.map((item) => {
              const active = isRouteActive(location.pathname, item.path);

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={cn(
                    "group relative flex items-center rounded-xl transition-all duration-150",
                    collapsed
                      ? "justify-center px-2 py-2.5"
                      : "gap-3 px-3 py-2.5",
                    active
                      ? "bg-blue-50/80 text-blue-700 dark:bg-blue-500/[0.08] dark:text-blue-400"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-white",
                  )}
                >
                  {/* Active left indicator (expanded) */}
                  {active && !collapsed && (
                    <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-blue-600 dark:bg-blue-400" />
                  )}
                  {/* Active bottom indicator (collapsed) */}
                  {active && collapsed && (
                    <span className="absolute bottom-0.5 left-1/2 h-[3px] w-5 -translate-x-1/2 rounded-full bg-blue-600 dark:bg-blue-400" />
                  )}

                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
                      active
                        ? "bg-blue-600 text-white shadow-[0_4px_12px_rgba(37,99,235,0.28)] dark:bg-blue-500 dark:shadow-[0_4px_12px_rgba(59,130,246,0.28)]"
                        : "bg-gray-100/80 text-gray-500 group-hover:bg-gray-200/60 group-hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-400 dark:group-hover:bg-white/[0.08] dark:group-hover:text-white",
                    )}
                  >
                    <item.icon className="h-[1.05rem] w-[1.05rem]" />
                  </span>

                  {!collapsed && (
                    <span className="truncate text-[0.82rem] font-semibold">{item.label}</span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* ─── Divider ─── */}
        <div className={cn("h-px bg-gray-100 dark:bg-white/[0.06]", collapsed ? "mx-3" : "mx-5")} />

        {/* ─── Footer: User Profile + Actions ─── */}
        <div className={cn("shrink-0", collapsed ? "px-2.5 py-3" : "px-4 py-4")}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2.5">
              {/* Avatar */}
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-xs font-bold text-white dark:from-blue-400 dark:to-blue-600">
                {operatorInitials}
                <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500 dark:border-[#0b1120]" />
              </div>

              {/* Expand toggle */}
              <button
                type="button"
                onClick={onToggle}
                className={iconBtnClass}
                aria-label="Expandir menu lateral"
              >
                <ChevronRight className="h-4 w-4" />
              </button>

              {/* Theme toggle */}
              <button
                type="button"
                onClick={toggleTheme}
                className={iconBtnClass}
                aria-label="Alternar tema"
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>

              {/* Logout */}
              <button
                type="button"
                onClick={handleSignOut}
                className={iconBtnClass}
                aria-label="Sair"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* User info */}
              <div className="flex items-center gap-3">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-xs font-bold text-white dark:from-blue-400 dark:to-blue-600">
                  {operatorInitials}
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500 dark:border-[#0b1120]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                    {operatorName}
                  </p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[0.68rem] text-gray-500 dark:text-gray-400">
                      Online · Operador
                    </span>
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1.5">
                {/* Theme toggle (wide) */}
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gray-100 text-xs font-semibold text-gray-600 transition-colors duration-150 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                >
                  {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                  {isDark ? "Claro" : "Escuro"}
                </button>

                {/* Collapse toggle */}
                <button
                  type="button"
                  onClick={onToggle}
                  className={iconBtnClass}
                  aria-label="Recolher menu lateral"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>

                {/* Logout */}
                <button
                  type="button"
                  onClick={handleSignOut}
                  className={iconBtnClass}
                  aria-label="Sair"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});

export default DashboardSidebar;

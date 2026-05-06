import { Suspense, lazy, useState } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import DashboardLayout from "./components/DashboardLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ProtectedRoute from "./components/ProtectedRoute";
import { AuthProvider } from "./hooks/useAuth";
import { DriverAuthProvider } from "./hooks/useDriverAuth";

const Overview = lazy(() => import("./pages/Overview"));
const ManageCargas = lazy(() => import("./pages/ManageCargas"));
const ManageClientes = lazy(() => import("./pages/ManageClientes"));
const ManageRoutes = lazy(() => import("./pages/ManageRoutes"));
const Leads = lazy(() => import("./pages/Leads"));
const HistoricoFila = lazy(() => import("./pages/HistoricoFila"));
const Motoristas = lazy(() => import("./pages/Motoristas"));
const AdminLogin = lazy(() => import("./pages/AdminLogin"));
const DriverPortal = lazy(() => import("./pages/DriverPortal"));
const DriverCargoDetails = lazy(() => import("./pages/DriverCargoDetails"));
const DriverClientDetails = lazy(() => import("./pages/DriverClientDetails"));
const OperatorDashboard = lazy(() => import("./pages/OperatorDashboard"));
const Veiculos = lazy(() => import("./pages/Veiculos"));
const SheetMonitor = lazy(() => import("./pages/SheetMonitor"));
const OperatorAuditLogs = lazy(() => import("./pages/OperatorAuditLogs"));
const CadastroDocumentos = lazy(() => import("./pages/cadastro/CadastroDocumentos"));
const NotFound = lazy(() => import("./pages/NotFound"));

const RouteFallback = () => (
  <div className="driver-theme flex min-h-screen items-center justify-center bg-background px-6 text-center">
    <div className="rounded-3xl border border-border bg-card px-8 py-6 shadow-[0_18px_40px_-26px_rgba(15,23,42,0.18)]">
      <div className="mx-auto h-10 w-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
      <p className="mt-4 text-sm font-semibold text-foreground">Carregando a interface...</p>
    </div>
  </div>
);

const App = () => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
  <ErrorBoundary>
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange={false}>
  <QueryClientProvider client={queryClient}>
    {/*
      Both AuthProvider (admin Supabase session) and DriverAuthProvider (driver Supabase session)
      are mounted at root level regardless of route. This is intentional:
      - They use separate Supabase client instances with isolated auth namespaces
      - Mounting both avoids layout flash when navigating between admin and driver areas
      - Each provider silently no-ops when its session is absent
      - The performance cost is two getSession() calls at startup (~50ms each)
    */}
    <AuthProvider>
      <DriverAuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                {/* Driver (mobile-first) */}
                <Route path="/motorista" element={<DriverPortal />} />
                <Route path="/motorista/cargas/:cargoId" element={<DriverCargoDetails />} />
                <Route path="/motorista/cliente/:clienteId" element={<DriverClientDetails />} />
                <Route path="/cargas/:cargoId" element={<DriverCargoDetails />} />
                {/* Driver registration (public, no auth) */}
                <Route path="/cadastro" element={<CadastroDocumentos />} />
                {/* Admin Login */}
                <Route path="/painel-x7k9m2" element={<AdminLogin />} />
                {/* Default: / always redirects to /motorista */}
                <Route path="/" element={<Navigate to="/motorista" replace />} />
                {/* Admin Dashboard (protected) */}
                <Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
                  <Route path="/painel" element={<Overview />} />
                  <Route path="/clientes" element={<ManageClientes />} />
                  <Route path="/cargas" element={<ManageCargas />} />
                  <Route path="/rotas" element={<ManageRoutes />} />
                  <Route path="/operador" element={<OperatorDashboard />} />
                  <Route path="/leads" element={<Leads />} />
                  <Route path="/historico-fila" element={<HistoricoFila />} />
                  <Route path="/motoristas" element={<Motoristas />} />
                  <Route path="/veiculos" element={<Veiculos />} />
                  <Route path="/planilha" element={<SheetMonitor />} />
                  <Route path="/auditoria" element={<OperatorAuditLogs />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </TooltipProvider>
      </DriverAuthProvider>
    </AuthProvider>
  </QueryClientProvider>
  </ThemeProvider>
  </ErrorBoundary>
  );
};

export default App;

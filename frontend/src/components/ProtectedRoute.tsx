import { Navigate } from "react-router-dom";

import { useAuth } from "@/hooks/useAuth";
import { getUserRole } from "@/lib/operatorAccess";

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const role = getUserRole(user);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/painel-x7k9m2" replace />;
  }

  if (role === "driver") {
    return <Navigate to="/motorista" replace />;
  }

  if (role !== "operator") {
    return <Navigate to="/painel-x7k9m2" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;

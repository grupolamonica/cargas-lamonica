/**
 * useOperatorPermissions
 *
 * Camada de defense-in-depth no client para esconder/desabilitar ações críticas
 * de operadores que não têm role/access_level adequado. O backend permanece a
 * fonte da verdade (RLS + handlers HTTP validam role), mas a UI antecipa
 * a checagem para evitar UX confusa (clique + 403).
 *
 * Modelo atual: `getUserRole(user)` retorna "operator" | "driver" | null e
 * `getOperatorAccessLevel(user)` retorna "advanced" | "intermediate" | null.
 *
 * Convenção:
 *   - `advanced`  → admin pleno (edição de perfil / mass-ops / alocar / clientes / rotas / valores)
 *   - `intermediate` → leitura + cadastrar + aprovar/rejeitar cadastros (alinha c/ backend)
 */

import { useContext } from "react";

import { AuthContext } from "@/hooks/useAuth";
import { getOperatorAccessLevel, getUserRole } from "@/lib/operatorAccess";

export interface OperatorPermissions {
  isOperator: boolean;
  isAdvanced: boolean;
  isIntermediate: boolean;
  canApproveMotoristas: boolean;
  canRejectMotoristas: boolean;
  canEditMotoristas: boolean;
  canBulkRevalidateVehicles: boolean;
  canAllocateLeads: boolean;
  canCancelLeads: boolean;
}

export function useOperatorPermissions(): OperatorPermissions {
  // Lê o contexto diretamente (não usa `useAuth`) para que páginas renderizadas
  // em testes sem `AuthProvider` recebam defaults conservadores em vez de erro.
  // Em produção o `ProtectedRoute` garante que o provider sempre existe.
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  const role = getUserRole(user);
  const accessLevel = getOperatorAccessLevel(user);

  const isOperator = role === "operator";
  const isAdvanced = isOperator && accessLevel === "advanced";
  const isIntermediate = isOperator && accessLevel === "intermediate";

  return {
    isOperator,
    isAdvanced,
    isIntermediate,
    // Aprovar/rejeitar cadastros: o backend (`/aprovar`, `/rejeitar`) permite
    // `intermediate` — o front alinha para não esconder a ação de quem pode
    // executá-la (senão o operador vê "sem permissão" mesmo podendo).
    canApproveMotoristas: isAdvanced || isIntermediate,
    canRejectMotoristas: isAdvanced || isIntermediate,
    // Demais ações sensíveis (edição de perfil / mass-ops / alocação): `advanced`.
    canEditMotoristas: isAdvanced,
    canBulkRevalidateVehicles: isAdvanced,
    canAllocateLeads: isAdvanced,
    // Cancelar candidatura é tratada como baixa-média criticidade — qualquer operador.
    canCancelLeads: isOperator,
  };
}

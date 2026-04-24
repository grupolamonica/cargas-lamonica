import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import ManageRoutes from "@/pages/ManageRoutes";

const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

const mockUseAuth = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
    useQueryClient: mockUseQueryClient,
  };
});

vi.mock("@/components/DashboardHeader", () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

describe("ManageRoutes", () => {
  beforeEach(() => {
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    });
    mockUseAuth.mockReturnValue({
      user: {
        app_metadata: {
          role: "operator",
          access_level: "intermediate",
        },
      },
    });
    mockUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "route-1",
            origem: "Salvador / BA",
            destino: "Campinas / SP",
            distancia_km: 1800,
            duracao_horas: 28,
            tempo_estimado_horas: 30,
            perfil_padrao: "CARRETA",
            valor_padrao: 8200,
            bonus_padrao: 350,
            ativa: true,
            observacoes: "Trecho prioritario",
            updated_at: "2026-04-14T10:00:00.000Z",
            source: "db",
            base_route_label: null,
            persisted: true,
          },
        ],
        supportsCatalogFields: true,
        summary: {
          totalRoutes: 1,
          activeRoutes: 1,
          baseRoutes: 0,
        },
        meta: {
          page: 1,
          pageSize: 8,
          totalCount: 1,
          totalPages: 1,
          hasNextPage: false,
          maxPageSize: 8,
          correlationId: "corr-routes-read-only",
        },
      },
      error: null,
      isFetching: false,
      isLoading: false,
    });
  });

  it("exibe a tela em modo somente leitura para operador intermediario", () => {
    render(<ManageRoutes />);

    expect(screen.getByText("Rotas com distancia, tempo estimado e valores de referencia")).toBeInTheDocument();
    const readOnlyBadges = screen.getAllByText(/somente leitura/i);
    expect(readOnlyBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Nova rota/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Editar rota/i })).not.toBeInTheDocument();
  });
});

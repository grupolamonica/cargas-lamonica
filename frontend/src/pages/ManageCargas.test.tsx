import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import ManageCargas from "@/pages/ManageCargas";

const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return { ...actual, useQuery: mockUseQuery, useQueryClient: mockUseQueryClient };
});

vi.mock("@/components/DashboardHeader", () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

const mockUseAuth = vi.fn();
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mockUseAuth() }));

// Carga LANÇADA pela Programação cuja viagem saiu do portal ASPX.
const cargaForaDoAspx = {
  id: "carga-1",
  data: "2026-08-01",
  horario: "06:00:00",
  origem: "Simoes Filho/BA",
  destino: "Salvador Retiro/BA",
  distancia_km: 40,
  duracao_horas: 1,
  perfil: "CARRETA",
  eixos: null,
  valor: 600,
  bonus: null,
  bonus_exigencias: null,
  driver_visibility: "PUBLIC" as const,
  status: "OPEN",
  is_template: false,
  cliente_id: "cliente-1",
  sheet_lh: null,
  codigo_viagem: null,
  lh_manual: "LT1Q8102CLEN1",
  aspx_missing_since: "2026-07-31T20:04:01.000Z",
  aspx_missing_lh: "LT1Q8102CLEN1",
  sheet_synced_at: null,
  sheet_data_carregamento: null,
  sheet_data_descarga: null,
  clientes: { nome: "E-COMMERCE" },
};

const meta = {
  page: 1,
  pageSize: 20,
  totalCount: 1,
  totalPages: 1,
  hasNextPage: false,
  maxPageSize: 20,
  correlationId: "corr-manage-cargas",
};

function mockQueries(cargo: Record<string, unknown>) {
  mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
    const key = Array.isArray(options?.queryKey) ? options.queryKey.map((k) => String(k)).join("|") : "";
    if (key.includes("clientes")) {
      // O hook de clientes desta tela devolve a LISTA (não o envelope paginado).
      return { data: [{ id: "cliente-1", nome: "E-COMMERCE" }], error: null, isFetching: false, isLoading: false };
    }
    if (key.includes("cargas")) {
      return { data: { items: [cargo], meta }, error: null, isFetching: false, isLoading: false };
    }
    return { data: undefined, error: null, isFetching: false, isLoading: false };
  });
}

describe("ManageCargas — carga cuja viagem saiu do ASPX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { app_metadata: { role: "operator", access_level: "advanced" } } });
    mockUseQueryClient.mockReturnValue({ setQueryData: vi.fn(), invalidateQueries: vi.fn() });
  });

  it("mostra o selo 'Fora do ASPX' e o LH da viagem lançada (a carga NÃO desaparece da tela)", () => {
    mockQueries(cargaForaDoAspx);

    render(
      <MemoryRouter>
        <ManageCargas />
      </MemoryRouter>,
    );

    // A carga continua listada, identificada pelo LH lançado (antes aparecia "—").
    expect(screen.getByText("LT1Q8102CLEN1")).toBeInTheDocument();
    expect(screen.getByText("Fora do ASPX")).toBeInTheDocument();
    // Status da carga é preservado (o aviso não cancela nem expira nada).
    // getAllByText: "Aberta"/"Abertas" também existe no seletor de filtro da tela.
    expect(screen.getAllByText("Aberta").length).toBeGreaterThanOrEqual(1);
  });

  it("sem a marca, nenhum selo aparece", () => {
    mockQueries({ ...cargaForaDoAspx, aspx_missing_since: null, aspx_missing_lh: null });

    render(
      <MemoryRouter>
        <ManageCargas />
      </MemoryRouter>,
    );

    expect(screen.getByText("LT1Q8102CLEN1")).toBeInTheDocument();
    expect(screen.queryByText("Fora do ASPX")).not.toBeInTheDocument();
  });
});

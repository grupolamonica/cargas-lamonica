import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Cliente } from "@/lib/clientes";
import ManageClientes from "@/pages/ManageClientes";

const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

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

const mockUseAuth = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

describe("ManageClientes", () => {
  const cliente = {
    id: "cliente-1",
    created_at: "2026-04-06T12:00:00.000Z",
    nome: "Acme Logistica",
    descricao: "Cliente com retorno no mesmo dia",
    logo_url: null,
    forma_pagamento: "Pix",
    prazo_pagamento: "48h",
    exige_rastreamento: false,
    exige_antt: false,
    exige_seguro: false,
    exige_carga_monitorada: false,
    reputacao_pagamento_rapido: false,
    reputacao_bom_pagador: false,
    reputacao_liberacao_rapida: false,
    reputacao_carga_organizada: false,
    reputacao_boa_comunicacao: false,
    observacoes: null,
    rastreamento: null,
    antt: null,
  } as Cliente;

  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: {
        app_metadata: {
          role: "operator",
          access_level: "advanced",
        },
      },
    });
    mockUseQueryClient.mockReturnValue({
      setQueryData: vi.fn(),
      invalidateQueries: vi.fn(),
    });
    mockUseQuery.mockReturnValue({
      data: {
        items: [cliente],
        meta: {
          page: 1,
          pageSize: 8,
          totalCount: 1,
          totalPages: 1,
          hasNextPage: false,
          maxPageSize: 8,
          correlationId: "corr-manage-clientes",
        },
      },
      error: null,
      isFetching: false,
      isLoading: false,
    });
  });

  it(
    "mantem a descricao fora do card e visivel apenas no modal",
    async () => {
      render(<ManageClientes />);

      expect(screen.getByRole("heading", { name: "Acme Logistica" })).toBeInTheDocument();
      expect(screen.queryByText("Cliente com retorno no mesmo dia")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Editar Acme Logistica" }));

      expect(await screen.findByText("Descrição da empresa")).toBeInTheDocument();
      expect(await screen.findByDisplayValue("Cliente com retorno no mesmo dia")).toBeInTheDocument();
    },
    15_000,
  );

  it("entra em modo somente leitura para operador intermediario", () => {
    mockUseAuth.mockReturnValue({
      user: {
        app_metadata: {
          role: "operator",
          access_level: "intermediate",
        },
      },
    });

    render(<ManageClientes />);

    const readOnlyBadges = screen.getAllByText(/somente leitura/i);
    expect(readOnlyBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Novo embarcador/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar Acme Logistica" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excluir Acme Logistica" })).not.toBeInTheDocument();
  });
});

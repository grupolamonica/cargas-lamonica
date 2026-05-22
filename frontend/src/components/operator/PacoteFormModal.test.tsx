import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

vi.mock("@/services/apiClient", () => ({
  getOperatorAccessToken: vi.fn().mockResolvedValue("test-token"),
  requestJson: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import PacoteFormModal from "./PacoteFormModal";
import { toast } from "sonner";
import * as operatorAdmin from "@/services/operatorAdmin";
import * as readModels from "@/services/readModels";

/**
 * Wrapper isolando QueryClient por teste — evita cache cruzado.
 */
function renderModal(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * Fixture mínima de OperatorCargoListItem suficiente para o PacoteCargaSelector.
 * Outros campos do read-model ficam como null/undefined; o componente não os usa.
 */
function makeCargo(over: Partial<readModels.OperatorCargoListItem>): readModels.OperatorCargoListItem {
  return {
    id: "carga-default",
    data: "2026-05-22",
    horario: "08:00",
    origem: "Sao Paulo",
    destino: "Salvador",
    distancia_km: 1800,
    duracao_horas: 28,
    perfil: "CARRETA",
    valor: 9000,
    bonus: null,
    bonus_exigencias: null,
    driver_visibility: "PREMIUM",
    status: "OPEN",
    is_template: false,
    cliente_id: "cli-1",
    sheet_lh: null,
    sheet_data_carregamento: null,
    sheet_data_descarga: null,
    clientes: { nome: "Cliente A" },
    viagem_id: null,
    ordem_viagem: null,
    pacote_meta: null,
    ...over,
  };
}

function makeReadModelResponse(items: readModels.OperatorCargoListItem[]) {
  return {
    items,
    meta: {
      page: 1,
      pageSize: 200,
      totalCount: items.length,
      totalPages: 1,
      hasNextPage: false,
      maxPageSize: 200,
      correlationId: "test",
    },
  };
}

describe("PacoteFormModal — validações client-side + orquestração de mutações", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submit fica desabilitado sem cargas selecionadas (proteção client-side)", async () => {
    vi.spyOn(readModels, "fetchOperatorCargas").mockResolvedValue(
      makeReadModelResponse([]),
    );

    renderModal(
      <PacoteFormModal open mode="create" onClose={() => {}} onSuccess={() => {}} />,
    );

    // Preenche valor mas não adiciona cargas
    fireEvent.change(screen.getByLabelText(/valor total/i), { target: { value: "1000" } });

    // Botão Criar permanece disabled (items.length === 0)
    const submitBtn = screen.getByRole("button", { name: /criar pacote/i });
    expect(submitBtn).toBeDisabled();
  });

  it("submit sem valor_total dispara toast.error", async () => {
    vi.spyOn(readModels, "fetchOperatorCargas").mockResolvedValue(
      makeReadModelResponse([
        makeCargo({ id: "c1", origem: "X", destino: "Y" }),
      ]),
    );

    renderModal(
      <PacoteFormModal open mode="create" onClose={() => {}} onSuccess={() => {}} />,
    );

    // Aguardar selector renderizar
    await waitFor(() => screen.getByTestId("carga-selector-list"));
    // Adicionar 1 carga (preenche items para passar o disabled do botão)
    const addBtn = await screen.findByRole("button", { name: /adicionar carga/i });
    fireEvent.click(addBtn);

    // Não preencher valor_total — submit deve disparar toast.error
    fireEvent.click(screen.getByRole("button", { name: /criar pacote/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/valor total/i)),
    );
  });

  it("create flow chama createPacote + 3 addCargaToPacote sequencialmente", async () => {
    const createSpy = vi.spyOn(operatorAdmin, "createPacote").mockResolvedValue({
      ok: true,
      pacote: {
        id: "p1",
        status: "rascunho",
        valor_total: 5000,
        version: 1,
        created_at: new Date().toISOString(),
      },
      meta: { correlationId: "test" },
    });
    const addSpy = vi.spyOn(operatorAdmin, "addCargaToPacote").mockResolvedValue({
      ok: true,
      pacoteId: "p1",
      cargaId: "x",
      ordem: 1,
      version: 1,
      total_cargas: 1,
      meta: { correlationId: "test" },
    });
    vi.spyOn(readModels, "fetchOperatorCargas").mockResolvedValue(
      makeReadModelResponse([
        makeCargo({ id: "c1", origem: "A", destino: "B" }),
        makeCargo({ id: "c2", origem: "B", destino: "C" }),
        makeCargo({ id: "c3", origem: "C", destino: "D" }),
      ]),
    );

    renderModal(
      <PacoteFormModal open mode="create" onClose={() => {}} onSuccess={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText(/valor total/i), { target: { value: "5000" } });
    await waitFor(() => screen.getByTestId("carga-selector-list"));

    const addButtons = await screen.findAllByRole("button", {
      name: /adicionar carga/i,
    });
    expect(addButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(addButtons[0]);
    fireEvent.click(addButtons[1]);
    fireEvent.click(addButtons[2]);

    fireEvent.click(screen.getByRole("button", { name: /criar pacote/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy).toHaveBeenCalledWith({ valor_total: 5000 });
    await waitFor(() => expect(addSpy).toHaveBeenCalledTimes(3));
  });

  it("traduz erro backend (limite_cargas_excedido) via translatePacoteError -> toast", async () => {
    vi.spyOn(operatorAdmin, "createPacote").mockRejectedValue({
      details: { code: "limite_cargas_excedido" },
      message: "raw msg",
    });
    vi.spyOn(readModels, "fetchOperatorCargas").mockResolvedValue(
      makeReadModelResponse([makeCargo({ id: "c1" })]),
    );

    renderModal(
      <PacoteFormModal open mode="create" onClose={() => {}} onSuccess={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText(/valor total/i), { target: { value: "1000" } });
    await waitFor(() => screen.getByTestId("carga-selector-list"));
    const addBtn = await screen.findByRole("button", { name: /adicionar carga/i });
    fireEvent.click(addBtn);
    fireEvent.click(screen.getByRole("button", { name: /criar pacote/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("3 cargas"),
      ),
    );
  });

  it("limite=3 — selector não permite adicionar 4a carga (hint + botão desabilitado)", async () => {
    vi.spyOn(readModels, "fetchOperatorCargas").mockResolvedValue(
      makeReadModelResponse([
        makeCargo({ id: "c1", origem: "A", destino: "B" }),
        makeCargo({ id: "c2", origem: "B", destino: "C" }),
        makeCargo({ id: "c3", origem: "C", destino: "D" }),
        makeCargo({ id: "c4", origem: "D", destino: "E" }),
      ]),
    );

    renderModal(
      <PacoteFormModal open mode="create" onClose={() => {}} onSuccess={() => {}} />,
    );

    await waitFor(() => screen.getByTestId("carga-selector-list"));
    const addButtons = await screen.findAllByRole("button", {
      name: /adicionar carga/i,
    });
    // Adicionar 3 cargas (limite)
    fireEvent.click(addButtons[0]);
    fireEvent.click(addButtons[1]);
    fireEvent.click(addButtons[2]);

    // Hint "Limite atingido" deve aparecer em PacoteCargaSelector
    await waitFor(() =>
      expect(screen.getByText(/limite atingido/i)).toBeInTheDocument(),
    );

    // O botão Adicionar restante (c4) deve estar disabled
    const remainingAddButtons = screen.queryAllByRole("button", {
      name: /adicionar carga/i,
    });
    if (remainingAddButtons.length > 0) {
      remainingAddButtons.forEach((btn) => expect(btn).toBeDisabled());
    }
  });
});

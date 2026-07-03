import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import CargoModal from "@/components/CargoModal";
import type { AssignableRouteOption } from "@/lib/assignableRoutes";

describe("CargoModal", () => {
  const route: AssignableRouteOption = {
    id: "route-1",
    route_key: "sao paulo|simoes filho",
    origin_key: "sao paulo",
    destination_key: "simoes filho",
    origem: "SAO PAULO",
    destino: "SIMOES FILHO",
    distancia_km: 1500,
    duracao_horas: 24,
    tempo_estimado_horas: 26,
    perfil_padrao: "CARRETA",
    valor_padrao: 14000,
    bonus_padrao: 500,
    ativa: true,
    base_route_label: "SAO PAULO X SIMOES FILHO",
    source: "base+db",
  };

  it("preenche a carga ao selecionar uma rota do catalogo", () => {
    render(
      <CargoModal
        open
        onClose={vi.fn()}
        onSave={vi.fn()}
        clientes={[{ id: "cliente-1", nome: "Cliente Teste" }]}
        routes={[route]}
      />,
    );

    // O primeiro combobox no DOM é o <select> "Rota padrão" (origem/destino agora
    // são CitySelector). Selecionar a rota herda perfil/valor/bônus do catálogo.
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: route.route_key },
    });

    expect(screen.getByDisplayValue("Carreta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("14000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
    expect(screen.getByText("Rota atribuída")).toBeInTheDocument();
  });

  it("atribui automaticamente a rota pelo trecho + veiculo (origem/destino/perfil)", () => {
    // Origem/destino são preenchidos via CitySelector (não mais <input> de texto),
    // então exercitamos o auto-match por initialData: ao abrir com o trecho + perfil
    // que casam com a rota, o valor/bônus daquele veículo é preenchido.
    render(
      <CargoModal
        open
        onClose={vi.fn()}
        onSave={vi.fn()}
        clientes={[{ id: "cliente-1", nome: "Cliente Teste" }]}
        routes={[route]}
        initialData={{
          data: "2026-04-07",
          horario: "08:00",
          route_key: "",
          origem: "São Paulo / SP",
          destino: "Simões Filho / BA",
          perfil: "CARRETA",
          eixos: 0,
          valor: "",
          bonus: "",
          bonus_exigencias: "",
          driver_visibility: "PUBLIC",
          cliente_id: "cliente-1",
          status: "OPEN",
          is_template: false,
        }}
      />,
    );

    expect(screen.getByDisplayValue("14000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
    expect(screen.getByText("Rota atribuída")).toBeInTheDocument();
  });

  it("mantem o cliente Shopee bloqueado para cargas vindas da planilha online", () => {
    const onSave = vi.fn();

    render(
      <CargoModal
        open
        onClose={vi.fn()}
        onSave={onSave}
        clientes={[
          { id: "client-shopee", nome: "Shopee" },
          { id: "client-2", nome: "Outro Cliente" },
        ]}
        routes={[route]}
        lockedClientId="client-shopee"
        lockedClientLabel="Shopee"
        initialData={{
          data: "2026-04-07",
          horario: "08:00",
          route_key: route.route_key,
          origem: route.origem,
          destino: route.destino,
          perfil: "CARRETA",
          valor: "14000",
          bonus: "500",
          bonus_exigencias: "Checklist enviado",
          driver_visibility: "PUBLIC",
          cliente_id: "client-2",
          status: "OPEN",
          is_template: false,
        }}
      />,
    );

    expect(screen.getByDisplayValue("Shopee")).toBeDisabled();

    fireEvent.click(screen.getByText("Salvar Carga"));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        cliente_id: "client-shopee",
      }),
    );
  });

  it("envia as exigencias do bonus junto com a carga", () => {
    const onSave = vi.fn();

    render(
      <CargoModal
        open
        onClose={vi.fn()}
        onSave={onSave}
        clientes={[{ id: "cliente-1", nome: "Cliente Teste" }]}
        routes={[route]}
        initialData={{
          data: "2026-04-09",
          horario: "10:30",
          route_key: route.route_key,
          origem: route.origem,
          destino: route.destino,
          perfil: "CARRETA",
          valor: "14000",
          bonus: "500",
          bonus_exigencias: "",
          driver_visibility: "PUBLIC",
          cliente_id: "cliente-1",
          status: "OPEN",
          is_template: false,
        }}
      />,
    );

    fireEvent.click(screen.getByText("Salvar Carga"));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        bonus_exigencias: "",
      }),
    );
  });

  it("permite marcar a carga como premium", () => {
    const onSave = vi.fn();

    render(
      <CargoModal
        open
        onClose={vi.fn()}
        onSave={onSave}
        clientes={[{ id: "cliente-1", nome: "Cliente Teste" }]}
        routes={[route]}
        initialData={{
          data: "2026-04-09",
          horario: "10:30",
          route_key: route.route_key,
          origem: route.origem,
          destino: route.destino,
          perfil: "CARRETA",
          valor: "14000",
          bonus: "500",
          bonus_exigencias: "",
          driver_visibility: "PUBLIC",
          cliente_id: "cliente-1",
          status: "OPEN",
          is_template: false,
        }}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Pública (aparece no portal do motorista)"), {
      target: { value: "PREMIUM" },
    });

    fireEvent.click(screen.getByText("Salvar Carga"));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        driver_visibility: "PREMIUM",
      }),
    );
  });
});

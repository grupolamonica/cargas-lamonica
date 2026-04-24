import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import LoadCard from "./LoadCard";

describe("LoadCard", () => {
  it("links the client name and shows candidacy and details actions", () => {
    render(
      <MemoryRouter>
        <LoadCard
          id="ABC12345"
          loadId="load-123"
          dateTime="Saída hoje às 08:00"
          clienteId="client-123"
          clienteNome="Cliente Exemplo"
          carregamentoLabel="03/04/2026 22:30"
          descargaLabel="04/04/2026 16:30"
          origemCidade="Salvador"
          origemEstado="BA"
          destinoCidade="Feira de Santana"
          destinoEstado="BA"
          tipoVeiculo="CARRETA"
          secondaryLabel="Percurso recomendado"
          secondaryValue="550 km"
          secondarySupportText="Tempo estimado: 7h 30min"
          pagamento="R$ 1.250,00"
          paymentDetails="R$ 1.000,00 da carga + R$ 250,00 de b\u00f4nus por concluir a entrega seguindo as normas pedidas"
          routeDistanceLabel="550 km"
          routeDurationLabel="Tempo estimado: 7h 30min"
          detailsHref="/motorista/cargas/load-123"
        />
      </MemoryRouter>,
    );

    const clientLinks = screen.getAllByRole("link", {
      name: /abrir dados de cliente exemplo/i,
    });

    expect(clientLinks).toHaveLength(2);
    clientLinks.forEach((clientLink) => {
      expect(clientLink).toHaveAttribute("href", "/motorista/cliente/client-123");
    });

    expect(screen.queryByText(/empresa com entrega rapida e atendimento direto/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/carregamento/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/descarga/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/saída hoje às 08:00/i)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /candidatar-se/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /detalhes/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tempo estimado: 7h 30min/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/03\/04\/2026 22:30/i)).toHaveLength(2);
    expect(screen.getAllByText(/04\/04\/2026 16:30/i)).toHaveLength(2);
  }, 15000);
});

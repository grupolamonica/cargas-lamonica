import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// AcessosCard é puramente apresentacional, mas o barril de imports puxa
// readModels → apiClient → supabase client. Mockamos como nos demais testes.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import { AcessosCard } from "./DriverFlowBlocks";
import type { DriverFlowMetricsResponse } from "@/services/readModels";

// Janela default de 7 dias (14→21/07), timezone BRT (03:00Z = meia-noite BRT).
function makeData(
  portalVisits: DriverFlowMetricsResponse["portalVisits"],
  windowOverride?: Partial<DriverFlowMetricsResponse["window"]>,
): DriverFlowMetricsResponse {
  return {
    window: { from: "2026-07-14T03:00:00.000Z", toExclusive: "2026-07-21T03:00:00.000Z", ...windowOverride },
    funnel: {
      preRegistered: 0,
      queued: 0,
      whatsappClicked: 0,
      approved: 0,
      cancelled: 0,
      avgPreregToWhatsappSeconds: null,
      avgPreregToApprovedSeconds: null,
    },
    accessPeaks: { byHour: [], byDow: [] },
    validation: {
      total: 0,
      valid: 0,
      expiring: 0,
      invalid: 0,
      notFound: 0,
      plateMismatch: 0,
      pending: 0,
      angeliraFound: 0,
      aspxFound: 0,
      topWarnings: [],
    },
    recurrence: { uniqueCpfs: 0, totalCandidaturas: 0, avgPerCpf: 0, maxPerCpf: 0, newDrivers: 0, recurringDrivers: 0 },
    portalVisits,
    cadastros: { realizados: 0, pendentes: 0 },
    portalAvailability: { total: 0 },
    meta: { correlationId: null },
  };
}

function byHourWithPeak(peakHour: number, peakTotal: number) {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, total: hour === peakHour ? peakTotal : 0 }));
}

describe("AcessosCard (DC-242)", () => {
  it("exibe a soma de acessos do período como número principal", () => {
    render(
      <AcessosCard
        data={makeData({ total: 1400, uniqueVisitors: 800, firstVisitAt: null, byHour: byHourWithPeak(8, 300), byDow: [] })}
      />,
    );
    // Critério de aceite: número exibido = soma do período (pt-BR: 1.400).
    expect(screen.getByText("1.400")).toBeInTheDocument();
    // Usuários únicos (COUNT DISTINCT request_ip).
    expect(screen.getByText("800")).toBeInTheDocument();
    // Média/dia = 1400 / 7 = 200.
    expect(screen.getByText("200")).toBeInTheDocument();
    // Pico de acesso derivado de byHour.
    expect(screen.getByText("08h")).toBeInTheDocument();
    expect(screen.getByText("300 acessos")).toBeInTheDocument();
  });

  it("é robusto a período sem acessos (zeros, sem pico)", () => {
    render(
      <AcessosCard data={makeData({ total: 0, uniqueVisitors: 0, firstVisitAt: null, byHour: byHourWithPeak(0, 0), byDow: [] })} />,
    );
    // Sem pico → traço; label 'acesso' no singular.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("sem dados")).toBeInTheDocument();
    expect(screen.getByText("acessos ao portal no intervalo escolhido")).toBeInTheDocument();
  });
});

describe("AcessosCard — modo todo o período (DC-241 fix)", () => {
  it("soma tudo e calcula a média/dia a partir do 1º acesso real (não do piso da janela)", () => {
    render(
      <AcessosCard
        data={makeData(
          {
            total: 1000,
            uniqueVisitors: 500,
            firstVisitAt: "2026-07-14T03:00:00.000Z", // 7 dias antes do fim
            byHour: byHourWithPeak(9, 250),
            byDow: [],
          },
          { from: "2000-01-01T00:00:00.000Z", toExclusive: "2026-07-21T03:00:00.000Z", allTime: true },
        )}
      />,
    );
    // Soma total mostrada (pt-BR: 1.000).
    expect(screen.getByText("1.000")).toBeInTheDocument();
    // Média/dia = 1000 / 7 = 143 (usa firstVisitAt). Se usasse o piso de 2000,
    // dividiria por ~9.700 dias e daria "0" — este assert prova o cálculo correto.
    expect(screen.getByText("143")).toBeInTheDocument();
    // Copy do modo "todo o período".
    expect(screen.getByText("Acessos (todo o período)")).toBeInTheDocument();
    expect(screen.getByText("acessos ao portal em todo o período")).toBeInTheDocument();
  });
});

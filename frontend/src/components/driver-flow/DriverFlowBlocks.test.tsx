import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// AcessosCard é puramente apresentacional, mas o barril de imports puxa
// readModels → apiClient → supabase client. Mockamos como nos demais testes.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import { AcessosCard } from "./DriverFlowBlocks";
import type { DriverFlowMetricsResponse } from "@/services/readModels";

// Janela de 7 dias (14→21/07), timezone BRT (03:00Z = meia-noite BRT).
function makeData(portalVisits: DriverFlowMetricsResponse["portalVisits"]): DriverFlowMetricsResponse {
  return {
    window: { from: "2026-07-14T03:00:00.000Z", toExclusive: "2026-07-21T03:00:00.000Z" },
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
        data={makeData({ total: 1400, uniqueVisitors: 800, byHour: byHourWithPeak(8, 300), byDow: [] })}
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
      <AcessosCard data={makeData({ total: 0, uniqueVisitors: 0, byHour: byHourWithPeak(0, 0), byDow: [] })} />,
    );
    // Sem pico → traço; label 'acesso' no singular.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("sem dados")).toBeInTheDocument();
    expect(screen.getByText("acessos ao portal no intervalo escolhido")).toBeInTheDocument();
  });
});

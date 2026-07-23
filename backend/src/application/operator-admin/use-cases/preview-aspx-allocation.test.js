import { describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async () => {
    throw new Error("withPgClient não deveria ser chamado (use deps.listCandidates)");
  },
}));

const { previewAspxAllocation } = await import("./preview-aspx-allocation.js");
const { SpxSidecarUnavailable } = await import("../../../infrastructure/spx/spx-allocation-client.js");

const CANDIDATES = [
  { sheet_lh: "LH1", origem: "SP", destino: "RJ", data: "2026-06-25", horario: "08:30:00", sheet_data_descarga: "2026-06-26 18:00", motorista: "João Silva", cavalo: "ABC1234", carreta: "XYZ9876", status: "", alloc_pinned: false },
  { sheet_lh: "LH2", origem: "SP", destino: "RJ", data: "2026-06-25", horario: "09:00:00", sheet_data_descarga: null, motorista: "Maria Souza", cavalo: "DEF5678", carreta: "", status: "", alloc_pinned: true },
  { sheet_lh: "LH3", origem: "MG", destino: "BA", data: "2026-06-24", horario: "07:00:00", sheet_data_descarga: null, motorista: "Pedro Lima", cavalo: "GHI0000", carreta: "", status: "CARREGADO", alloc_pinned: false },
];

const emptyIndex = () => ({ byNumber: new Map(), truncated: false, partial: false });

describe("previewAspxAllocation — só mostra o que muda/diverge", () => {
  it("'assign' aparece com agenda (carregamento + descarga)", async () => {
    const res = await previewAspxAllocation({
      correlationId: "c1",
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [{ trip_id: 11, trip_number: "LH1" }],
        fetchDrivers: async () => [{ driver_id: 91, name: "JOAO SILVA" }],
        fetchIndex: emptyIndex,
      },
    });
    expect(res.payload.items).toHaveLength(1);
    const it0 = res.payload.items[0];
    expect(it0.state).toBe("assign");
    expect(it0.tripId).toBe(11);
    expect(it0.driverId).toBe(91);
    expect(it0.carregamentoLabel).toBe("25/06/2026 08:30");
    expect(it0.descargaLabel).toBe("26/06/2026 18:00");
    expect(res.payload.summary.willAssign).toBe(1);
  });

  it("'pending' (motorista não casa) aparece", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [{ trip_id: 11, trip_number: "LH1" }],
        fetchDrivers: async () => [],
        fetchIndex: emptyIndex,
      },
    });
    expect(res.payload.items).toHaveLength(1);
    expect(res.payload.items[0].state).toBe("pending");
    expect(res.payload.summary.pending).toBe(1);
  });

  it("divergente aparece (reassignable c/ trip_id+driver); já-em-dia e cancelada OCULTADAS", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0], CANDIDATES[1], CANDIDATES[2]],
        fetchTrips: async () => [],
        fetchDrivers: async () => [{ driver_id: 91, name: "JOAO SILVA" }], // motorista do sistema disponível p/ trocar
        fetchIndex: async () => ({
          byNumber: new Map([
            ["LH1", { tripId: 555, status: 5, statusName: "Assigned", driver: "OUTRO MOTORISTA" }], // diverge de João Silva
            ["LH2", { tripId: 556, status: 5, statusName: "Assigned", driver: "Maria Souza" }], // igual → oculta
            ["LH3", { tripId: 557, status: 100, statusName: "Cancelled", driver: "" }], // cancelada → oculta
          ]),
          truncated: false,
          partial: false,
        }),
      },
    });
    expect(res.payload.items).toHaveLength(1); // só a divergente
    const it0 = res.payload.items[0];
    expect(it0.lh).toBe("LH1");
    expect(it0.divergent).toBe(true);
    expect(it0.assignedDriver).toBe("OUTRO MOTORISTA");
    expect(it0.reassignable).toBe(true); // trip_id (555) + driver do sistema (91) resolvidos
    expect(it0.tripId).toBe(555);
    expect(it0.driverId).toBe(91);
    expect(res.payload.summary.divergent).toBe(1);
    expect(res.payload.summary.alreadyAssigned).toBe(2); // LH1 + LH2 (contexto)
    expect(res.payload.summary.cancelled).toBe(1);
    expect(res.payload.summary.hidden).toBe(2); // LH2 + LH3 ocultadas
    expect(res.payload.summary.totalCandidates).toBe(3);
  });

  it("divergente SEM motorista do sistema no ASPX → aparece, mas NÃO reassignable", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [],
        fetchDrivers: async () => [], // João Silva não está disponível
        fetchIndex: async () => ({
          byNumber: new Map([["LH1", { tripId: 555, status: 5, statusName: "Assigned", driver: "OUTRO" }]]),
          truncated: false,
          partial: false,
        }),
      },
    });
    expect(res.payload.items).toHaveLength(1);
    expect(res.payload.items[0].divergent).toBe(true);
    expect(res.payload.items[0].reassignable).toBe(false);
  });

  it("status 4 (Assigning) COM motorista divergente → assigned + divergent (aparece)", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [], // não está em assignable (já tem motorista)
        fetchDrivers: async () => [],
        fetchIndex: async () => ({
          byNumber: new Map([["LH1", { status: 4, statusName: "Assigning", driver: "OUTRO" }]]),
          truncated: false,
          partial: false,
        }),
      },
    });
    expect(res.payload.items).toHaveLength(1);
    expect(res.payload.items[0].state).toBe("assigned");
    expect(res.payload.items[0].divergent).toBe(true);
  });

  it("viagem CONCLUÍDA (status 90) com motorista divergente → OCULTA (não é acionável)", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [],
        fetchDrivers: async () => [{ driver_id: 91, name: "JOAO SILVA" }],
        fetchIndex: async () => ({
          byNumber: new Map([["LH1", { tripId: 5, status: 90, statusName: "Completed", driver: "OUTRO MOTORISTA" }]]),
          truncated: false,
          partial: false,
        }),
      },
    });
    // Divergência em viagem concluída não conta → nada a mostrar (fica em "done").
    expect(res.payload.items).toHaveLength(0);
    expect(res.payload.summary.divergent).toBe(0);
    expect(res.payload.summary.alreadyAssigned).toBe(1); // done entra no contexto
  });

  it("consulta o índice INCLUINDO o Concluído (mesma janela do selo)", async () => {
    const fetchIndex = vi.fn(async () => emptyIndex());
    await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0]],
        fetchTrips: async () => [],
        fetchDrivers: async () => [],
        fetchIndex,
      },
    });
    expect(fetchIndex).toHaveBeenCalledWith(expect.objectContaining({ includeConcluido: true }));
  });

  it("tudo em dia → items vazio (nada a alterar)", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[1]],
        fetchTrips: async () => [],
        fetchDrivers: async () => [],
        fetchIndex: async () => ({
          byNumber: new Map([["LH2", { status: 5, statusName: "Assigned", driver: "Maria Souza" }]]),
          truncated: false,
          partial: false,
        }),
      },
    });
    expect(res.payload.items).toHaveLength(0);
    expect(res.payload.summary.hidden).toBe(1);
  });

  it("guarda: warning 'assignable_empty' quando a lista atribuível vem vazia com candidatos", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => CANDIDATES,
        fetchTrips: async () => [],
        fetchDrivers: async () => [],
        fetchIndex: emptyIndex,
      },
    });
    expect(res.payload.warnings).toContain("assignable_empty");
  });

  it("degradação granular: índice falha sozinho → assign segue + warning", async () => {
    const res = await previewAspxAllocation({
      deps: {
        listCandidates: async () => [CANDIDATES[0], CANDIDATES[2]],
        fetchTrips: async () => [{ trip_id: 11, trip_number: "LH1" }],
        fetchDrivers: async () => [{ driver_id: 91, name: "JOAO SILVA" }],
        fetchIndex: async () => { throw new Error("snapshot 502"); },
      },
    });
    expect(res.payload.items).toHaveLength(1); // LH1 assign; LH3 unknown oculto
    expect(res.payload.items[0].state).toBe("assign");
    expect(res.payload.warnings).toContain("index_unavailable");
  });

  it("sidecar fora do ar → propaga erro (sem modo simulação)", async () => {
    await expect(
      previewAspxAllocation({
        deps: {
          listCandidates: async () => CANDIDATES,
          fetchTrips: async () => { throw new SpxSidecarUnavailable("down"); },
          fetchDrivers: async () => [],
          fetchIndex: emptyIndex,
        },
      }),
    ).rejects.toThrow(SpxSidecarUnavailable);
  });
});

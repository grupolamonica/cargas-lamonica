import { describe, expect, it } from "vitest";
import { mapSystemCargoToMonitorRow, listSystemCargasForMonitor } from "./list-system-cargas-monitor.js";

describe("mapSystemCargoToMonitorRow", () => {
  it("projeta uma carga do sistema no shape de linha do Monitor", () => {
    const r = mapSystemCargoToMonitorRow({
      id: "11111111-1111-1111-1111-111111111111",
      origem: "São Paulo/SP",
      destino: "Salvador/BA",
      data: "2026-06-25",
      horario: "08:30:00",
      alloc_motorista: "João Silva",
      alloc_cavalo: "ABC1234",
      alloc_carreta: "",
      alloc_status: "CARREGADO",
      alloc_pinned: false,
      status: "OPEN",
      lh_manual: "MINHA-LH-1",
      sheet_data_descarga: "2026-06-26 18:00",
    });
    expect(r.rowKey).toBe("cargo:11111111-1111-1111-1111-111111111111");
    expect(r.source).toBe("sistema");
    expect(r.cargoId).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.lh).toBe("MINHA-LH-1");
    expect(r.tipo).toBe("SISTEMA");
    expect(r.motoristas).toBe("João Silva");
    expect(r.cavalo).toBe("ABC1234");
    expect(r.status).toBe("CARREGADO");
    expect(r.data).toBe("2026-06-25");
    expect(r.horario).toBe("08:30");
    expect(r.hasDriver).toBe(true);
    expect(r.isAvailable).toBe(false);
    expect(r.lifecycleStatus).toBe("OPEN");
    // Agenda: carregamento (data+hora) + descarga (sheet_data_descarga)
    expect(r.carregamentoLabel).toBe("25/06/2026 08:30");
    expect(r.cargaAt).toBe("2026-06-25T08:30");
    expect(r.descargaLabel).toBe("26/06/2026 18:00");
    expect(r.descargaAt).toBe("2026-06-26T18:00");
  });

  it("data ISO (UTC-midnight) é fatiada corretamente; sem motorista = disponível", () => {
    const r = mapSystemCargoToMonitorRow({
      id: "22222222-2222-2222-2222-222222222222",
      origem: "A",
      destino: "B",
      data: "2026-06-25T00:00:00.000Z",
      horario: "14:00:00",
      alloc_motorista: null,
      alloc_status: null,
      lh_manual: null,
    });
    expect(r.data).toBe("2026-06-25");
    expect(r.horario).toBe("14:00");
    expect(r.lh).toBe("");
    expect(r.isAvailable).toBe(true);
    expect(r.hasDriver).toBe(false);
  });
});

describe("listSystemCargasForMonitor", () => {
  function fakeClient(pages) {
    let call = 0;
    const api = {
      from: () => api,
      select: () => api,
      is: () => api,
      eq: () => api,
      neq: () => api,
      order: () => api,
      range: async () => ({ data: pages[call++] ?? [], error: null }),
    };
    return api;
  }

  it("pagina via .range até esgotar (< pageSize encerra)", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({ id: `a${i}`, origem: "X", destino: "Y", data: "2026-06-01", horario: "07:00:00" }));
    const rows = await listSystemCargasForMonitor(fakeClient([page1]), { pageSize: 2, maxRows: 10 });
    // page1 tem 2 (== pageSize) → busca page2; page2 vazia → encerra. Total 2.
    expect(rows.length).toBe(2);
    expect(rows[0].rowKey).toBe("cargo:a0");
  });

  it("propaga erro do supabase", async () => {
    const api = { from: () => api, select: () => api, is: () => api, eq: () => api, neq: () => api, order: () => api, range: async () => ({ data: null, error: new Error("boom") }) };
    await expect(listSystemCargasForMonitor(api)).rejects.toThrow("boom");
  });
});

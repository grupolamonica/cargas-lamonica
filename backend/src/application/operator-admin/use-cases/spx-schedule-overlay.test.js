import { describe, expect, it, vi } from "vitest";

import { fetchSpxScheduleIndex, applySpxSchedule } from "./spx-schedule-overlay.js";
import { SpxAspNotConfigured, SpxAspUnavailable } from "../../../infrastructure/torre/torre-spx-trips-client.js";

// Linha da Torre asp (chaves humanas, como o payload real).
function aspRow(lh, o = {}) {
  return {
    "LH Trip Number": lh,
    "ETA ORIGEM PROGRAMADO": o.origProg ?? "",
    "ETA ORIGEM REAL": o.origReal ?? "",
    "ETA DESTINO PROGRAMADO": o.destProg ?? "",
    "ETA DESTINO REAL": o.destReal ?? "",
  };
}
const makeFetch = (rows) => vi.fn(async () => ({ ok: true, rows }));

describe("fetchSpxScheduleIndex (Torre asp → carga/descarga por LH)", () => {
  it("indexa ETA ORIGEM (carga) e ETA DESTINO (descarga) e converte o formato", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT0Q7L02BUPP1", { origProg: "21/07/2026 18:00", destProg: "26/07/2026 08:00" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    const s = idx.get("LT0Q7L02BUPP1");
    expect(s.carga).toEqual({ label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" });
    expect(s.descarga).toEqual({ label: "26/07/2026 08:00", dateIso: "2026-07-26", timeIso: "08:00", at: "2026-07-26T08:00" });
  });

  it("usa PROGRAMADO (== planilha) mesmo quando há REAL", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT1", { origProg: "21/07/2026 18:00", origReal: "21/07/2026 19:30", destProg: "26/07/2026 08:00", destReal: "26/07/2026 07:10" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.get("LT1").carga.label).toBe("21/07/2026 18:00");
    expect(idx.get("LT1").descarga.label).toBe("26/07/2026 08:00");
  });

  it("cai para REAL quando PROGRAMADO vem vazio (fallback)", async () => {
    const fetchSpx = makeFetch([
      aspRow("LT2", { origProg: "", origReal: "21/07/2026 19:30", destProg: "", destReal: "26/07/2026 07:10" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.get("LT2").carga.label).toBe("21/07/2026 19:30");
    expect(idx.get("LT2").descarga.label).toBe("26/07/2026 07:10");
  });

  it("ignora linha sem LH e linha sem nenhuma data", async () => {
    const fetchSpx = makeFetch([
      aspRow("", { origProg: "21/07/2026 18:00" }),
      aspRow("LT-VAZIO", {}),
      aspRow("LT-OK", { origProg: "21/07/2026 18:00" }),
    ]);
    const idx = await fetchSpxScheduleIndex({ deps: { fetchSpx } });
    expect(idx.has("LT-VAZIO")).toBe(false);
    expect(idx.size).toBe(1);
    expect(idx.get("LT-OK").carga.label).toBe("21/07/2026 18:00");
    expect(idx.get("LT-OK").descarga).toBeNull();
  });

  it("sem chave configurada → null (silencioso)", async () => {
    const fetchSpx = vi.fn(async () => { throw new SpxAspNotConfigured(); });
    expect(await fetchSpxScheduleIndex({ deps: { fetchSpx } })).toBeNull();
  });

  it("Torre indisponível → null (best-effort, não quebra)", async () => {
    const fetchSpx = vi.fn(async () => { throw new SpxAspUnavailable(); });
    expect(await fetchSpxScheduleIndex({ deps: { fetchSpx } })).toBeNull();
  });
});

describe("applySpxSchedule (sobrepõe agenda por LH)", () => {
  const sheetRow = () => ({
    lh: "LT0Q7L02BUPP1",
    carregamentoLabel: "21/07/2026 16:00",
    descargaLabel: "25/07/2026 06:00",
    data: "2026-07-21",
    horario: "16:00:00",
    motoristas: "JOAO",
    status: "AGUARDANDO CARREGAMENTO",
  });

  it("sobrepõe carga+descarga (label/data/horario/cargaAt/descargaAt) quando o LH casa", () => {
    const idx = new Map([["LT0Q7L02BUPP1", {
      carga: { label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" },
      descarga: { label: "26/07/2026 08:00", dateIso: "2026-07-26", timeIso: "08:00", at: "2026-07-26T08:00" },
    }]]);
    const out = applySpxSchedule(sheetRow(), { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("21/07/2026 18:00");
    expect(out.data).toBe("2026-07-21");
    expect(out.horario).toBe("18:00");
    expect(out.cargaAt).toBe("2026-07-21T18:00");
    expect(out.descargaLabel).toBe("26/07/2026 08:00");
    expect(out.descargaAt).toBe("2026-07-26T08:00");
    // Não toca motorista/status.
    expect(out.motoristas).toBe("JOAO");
    expect(out.status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("só carga presente → não zera descarga da planilha", () => {
    const idx = new Map([["LT0Q7L02BUPP1", {
      carga: { label: "21/07/2026 18:00", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" },
      descarga: null,
    }]]);
    const out = applySpxSchedule(sheetRow(), { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("21/07/2026 18:00");
    expect(out.descargaLabel).toBe("25/07/2026 06:00"); // preservada
  });

  it("sem índice ou sem match → linha inalterada", () => {
    const row = sheetRow();
    expect(applySpxSchedule(row, { spxScheduleByLh: null })).toBe(row);
    expect(applySpxSchedule(row, { spxScheduleByLh: new Map() })).toBe(row);
    expect(applySpxSchedule(row, { spxScheduleByLh: new Map([["OUTRO", { carga: null, descarga: null }]]) })).toBe(row);
  });

  it("linha Nestlé/sistema (LH que não casa) fica intacta", () => {
    const nestle = { lh: "B101462715", carregamentoLabel: "20/07/2026 08:00", descargaLabel: "21/07/2026 10:00" };
    const idx = new Map([["LT-XYZ", { carga: { label: "x", dateIso: "2026-07-21", timeIso: "18:00", at: "2026-07-21T18:00" }, descarga: null }]]);
    const out = applySpxSchedule(nestle, { spxScheduleByLh: idx });
    expect(out.carregamentoLabel).toBe("20/07/2026 08:00");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSheetWritebackEnabled,
  writeAllocationsToSheet,
  formatSheetDateLabel,
  buildSystemCargoShellRow,
} from "./sheet-writeback.js";

const URL_KEY = "GOOGLE_SHEET_WRITEBACK_URL";
const SECRET_KEY = "GOOGLE_SHEET_WRITEBACK_SECRET";
const NESTLE_URL_KEY = "GOOGLE_SHEET_NESTLE_WRITEBACK_URL";
const NESTLE_SECRET_KEY = "GOOGLE_SHEET_NESTLE_WRITEBACK_SECRET";
const TEST_URL = "https://script.google.com/macros/s/abc/exec";
const NESTLE_URL = "https://script.google.com/macros/s/nestle/exec";
const ALL_KEYS = [URL_KEY, SECRET_KEY, NESTLE_URL_KEY, NESTLE_SECRET_KEY];

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(obj) };
}

describe("sheet-writeback", () => {
  let prev;
  beforeEach(() => {
    prev = Object.fromEntries(ALL_KEYS.map((k) => [k, process.env[k]]));
    // isola: cada teste liga só as chaves que precisa.
    for (const k of ALL_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ALL_KEYS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    vi.restoreAllMocks();
  });

  it("desligado (sem URL) → skipped, sem chamar fetch", async () => {
    delete process.env[URL_KEY];
    const fetchImpl = vi.fn();
    const res = await writeAllocationsToSheet([{ lh: "X", motorista: "A" }], { fetchImpl });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isSheetWritebackEnabled()).toBe(false);
  });

  it("updates vazio → não chama fetch, updated 0", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn();
    const res = await writeAllocationsToSheet([], { fetchImpl });
    expect(res).toEqual({ ok: true, updated: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sucesso: envia secret + updates normalizados e retorna updated", async () => {
    process.env[URL_KEY] = TEST_URL;
    process.env[SECRET_KEY] = "segredo";
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 2 }));
    const res = await writeAllocationsToSheet(
      [{ lh: "L1", motorista: "A", cavalo: "C1" }, { lh: "L2", motorista: "" }],
      { fetchImpl },
    );
    expect(res).toEqual({ ok: true, updated: 2 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.secret).toBe("segredo");
    expect(body.updates).toEqual([
      { lh: "L1", motorista: "A", cavalo: "C1", carreta: "" },
      { lh: "L2", motorista: "", cavalo: "", carreta: "" },
    ]);
  });

  it("status/vinculo só vão quando a chave está presente (senão omite p/ não sobrescrever L/H)", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 2 }));
    await writeAllocationsToSheet(
      [
        { lh: "L1", motorista: "A", status: "DESCARREGADO", vinculo: "TERCEIRO" },
        { lh: "L2", motorista: "B" }, // sem status/vinculo → omitidos
      ],
      { fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.updates[0]).toEqual({
      lh: "L1", motorista: "A", cavalo: "", carreta: "", status: "DESCARREGADO", vinculo: "TERCEIRO",
    });
    expect(body.updates[1]).toEqual({ lh: "L2", motorista: "B", cavalo: "", carreta: "" });
    expect("status" in body.updates[1]).toBe(false);
    expect("vinculo" in body.updates[1]).toBe(false);
  });

  it("createIfMissing encaminha os campos de linha completa (carga do sistema); ausente → nem createIfMissing nem campos", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1, created: 1 }));
    await writeAllocationsToSheet(
      [
        {
          lh: "LT-SYS-1", motorista: "ABELARDO", cavalo: "CUA1123", carreta: "FDZ0B46", status: "",
          createIfMissing: true, tipo: "Spot", dataCarregamento: "01/08/2026 14:00",
          dataDescarga: "03/08/2026 09:00", origem: "SJ Rio Preto / SP", destino: "Simoes Filho / BA",
        },
        // Edição normal (LH da planilha): sem createIfMissing → não encaminha nada disso.
        { lh: "LT-SHEET-1", motorista: "B", tipo: "ForeCast", origem: "IGNORAR" },
      ],
      { fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.updates[0]).toEqual({
      lh: "LT-SYS-1", motorista: "ABELARDO", cavalo: "CUA1123", carreta: "FDZ0B46", status: "",
      createIfMissing: true, tipo: "Spot", dataCarregamento: "01/08/2026 14:00",
      dataDescarga: "03/08/2026 09:00", origem: "SJ Rio Preto / SP", destino: "Simoes Filho / BA",
    });
    // Sem createIfMissing → tipo/origem NÃO são encaminhados (não criam/tocam a linha).
    expect(body.updates[1]).toEqual({ lh: "LT-SHEET-1", motorista: "B", cavalo: "", carreta: "" });
    expect("createIfMissing" in body.updates[1]).toBe(false);
    expect("tipo" in body.updates[1]).toBe(false);
  });

  it("syncExtras (sync ASPX / DC-316) encaminha datas/origem/destino num UPDATE — sem tipo, sem create flag", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1 }));
    await writeAllocationsToSheet(
      [{
        lh: "LT-ASPX-1", motorista: "M", cavalo: "C", carreta: "R", status: "CARREGADO",
        syncExtras: true, tipo: "IGNORAR", dataCarregamento: "27/07/2026 08:00",
        dataDescarga: "28/07/2026 10:00", origem: "Sao Paulo", destino: "Salvador",
      }],
      { fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.updates[0]).toEqual({
      lh: "LT-ASPX-1", motorista: "M", cavalo: "C", carreta: "R", status: "CARREGADO",
      dataCarregamento: "27/07/2026 08:00", dataDescarga: "28/07/2026 10:00",
      origem: "Sao Paulo", destino: "Salvador",
    });
    // syncExtras é só controle (não vai pro fio); tipo é só create; sem createOnly → update path.
    expect("syncExtras" in body.updates[0]).toBe(false);
    expect("tipo" in body.updates[0]).toBe(false);
    expect("createOnly" in body.updates[0]).toBe(false);
  });

  it("createOnly encaminha os campos de linha (linha-casca do lançamento/aceite)", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 0, created: 1 }));
    await writeAllocationsToSheet(
      [
        {
          lh: "LT-SHELL-1", motorista: "", cavalo: "", carreta: "", status: "",
          createOnly: true, tipo: "", dataCarregamento: "05/08/2026 14:00",
          dataDescarga: "", origem: "SJ Rio Preto / SP", destino: "Simoes Filho / BA",
        },
      ],
      { fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.updates[0]).toEqual({
      lh: "LT-SHELL-1", motorista: "", cavalo: "", carreta: "", status: "",
      createOnly: true, tipo: "", dataCarregamento: "05/08/2026 14:00",
      dataDescarga: "", origem: "SJ Rio Preto / SP", destino: "Simoes Filho / BA",
    });
    expect("createIfMissing" in body.updates[0]).toBe(false);
  });

  it("formatSheetDateLabel: ISO → DD/MM/YYYY HH:MM; não-ISO passa direto; vazio → ''", () => {
    expect(formatSheetDateLabel("2026-08-05T14:00")).toBe("05/08/2026 14:00");
    expect(formatSheetDateLabel("A confirmar")).toBe("A confirmar");
    expect(formatSheetDateLabel(null)).toBe("");
    expect(formatSheetDateLabel("")).toBe("");
  });

  it("buildSystemCargoShellRow: monta a linha-casca (createOnly, sem motorista, datas formatadas)", () => {
    const shell = buildSystemCargoShellRow({
      lh: " LT-X1 ", source: "shopee", origem: "A / SP", destino: "B / BA",
      carregamentoLabel: "2026-08-05T14:00", descargaLabel: null,
    });
    expect(shell).toEqual({
      lh: "LT-X1", source: "shopee", createOnly: true,
      motorista: "", cavalo: "", carreta: "", status: "", tipo: "",
      dataCarregamento: "05/08/2026 14:00", dataDescarga: "",
      origem: "A / SP", destino: "B / BA",
    });
  });

  it("resposta ok:false (ex.: forbidden) → ok:false, não lança", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "forbidden" }));
    const res = await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("HTTP 200 com HTML de erro (Apps Script quebrado) → FALHA, não sucesso silencioso", async () => {
    // Regressão do incidente 2026-07-22: o Apps Script publicado quebrado retorna
    // HTTP 200 com uma página HTML ("ReferenceError: out_ is not defined"). O parse
    // falha → body=null. Antes isso contava como sucesso (write-back silenciosamente
    // sem gravar). Agora tem que ser FALHA.
    process.env[URL_KEY] = TEST_URL;
    const html = '<!DOCTYPE html><html><body><div>ReferenceError: out_ is not defined</div></body></html>';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => html });
    const log = vi.fn();
    const res = await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl, log });
    expect(res.ok).toBe(false);
    expect(res.updated).toBe(0);
    // Falha é logada como "error" (alarmável), não engolida.
    expect(log).toHaveBeenCalledWith("error", "failed", expect.objectContaining({ status: 200 }));
  });

  it("fetch lança → ok:false, NUNCA propaga o erro", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const res = await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
  });

  // ── Roteamento por fonte (shopee vs nestle) ──────────────────────────────
  it("source=nestle → POST na URL da Nestlé, com o segredo da Nestlé; source NÃO vai no body", async () => {
    process.env[URL_KEY] = TEST_URL;
    process.env[SECRET_KEY] = "seg-shopee";
    process.env[NESTLE_URL_KEY] = NESTLE_URL;
    process.env[NESTLE_SECRET_KEY] = "seg-nestle";
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1 }));
    const res = await writeAllocationsToSheet(
      [{ lh: "B101457376", source: "nestle", motorista: "MARCELO", status: "AGUAR. CARREGAMENTO" }],
      { fetchImpl },
    );
    expect(res).toEqual({ ok: true, updated: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(NESTLE_URL);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.secret).toBe("seg-nestle");
    expect(body.updates[0]).toEqual({ lh: "B101457376", motorista: "MARCELO", cavalo: "", carreta: "", status: "AGUAR. CARREGAMENTO" });
    expect("source" in body.updates[0]).toBe(false);
  });

  it("Nestlé SEM URL configurada → no-op p/ nestle (não é erro); shopee no mesmo lote ainda grava", async () => {
    process.env[URL_KEY] = TEST_URL; // só shopee configurada
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1 }));
    const res = await writeAllocationsToSheet(
      [
        { lh: "LT1", source: "shopee", motorista: "A" },
        { lh: "B101", source: "nestle", motorista: "B" },
      ],
      { fetchImpl },
    );
    // só a shopee foi enviada; nestle pulada silenciosamente (sem URL).
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(TEST_URL);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.updates.map((u) => u.lh)).toEqual(["LT1"]);
  });

  it("lote com fontes misturadas → um POST por fonte, cada um na sua URL", async () => {
    process.env[URL_KEY] = TEST_URL;
    process.env[NESTLE_URL_KEY] = NESTLE_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1 }));
    await writeAllocationsToSheet(
      [
        { lh: "LT1", source: "shopee", motorista: "A" },
        { lh: "B101", source: "nestle", motorista: "B" },
      ],
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual([NESTLE_URL, TEST_URL].sort());
  });

  it("sem source (legado) → cai na shopee", async () => {
    process.env[URL_KEY] = TEST_URL;
    process.env[NESTLE_URL_KEY] = NESTLE_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 1 }));
    await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(TEST_URL);
  });

  it("isSheetWritebackEnabled('nestle') reflete só a URL da Nestlé", async () => {
    process.env[URL_KEY] = TEST_URL; // shopee on
    expect(isSheetWritebackEnabled("nestle")).toBe(false);
    process.env[NESTLE_URL_KEY] = NESTLE_URL;
    expect(isSheetWritebackEnabled("nestle")).toBe(true);
    expect(isSheetWritebackEnabled()).toBe(true); // shopee (padrão)
  });
});

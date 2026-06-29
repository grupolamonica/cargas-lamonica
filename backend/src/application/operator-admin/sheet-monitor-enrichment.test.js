import { describe, expect, it } from "vitest";
import {
  buildEnrichedUpsertRow,
  mergePreservingGood,
  matchAspxDriver,
  indexAspxList,
  fetchEnrichedLhSet,
  filterRowsToProcess,
} from "./sheet-monitor-enrichment.js";

// Mock do client supabase para sheet_monitor_enriched: simula a paginação do
// PostgREST (cada .range devolve no máximo o tamanho do intervalo). `rows` =
// [{ lh, enriched_at }]. Suporta o filtro .gte("enriched_at", sinceIso).
function makeEnrichedClient(rows) {
  return {
    from() {
      let since = null;
      const builder = {
        select() {
          return builder;
        },
        gte(_col, val) {
          since = val;
          return builder;
        },
        order() {
          return builder;
        },
        range(from, to) {
          const filtered = since ? rows.filter((r) => r.enriched_at >= since) : rows;
          return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
        },
      };
      return builder;
    },
  };
}

// Relativos ao relógio real — filterRowsToProcess usa Date.now() p/ o corte de
// 6h (STALE_HOURS), então datas fixas viram flaky quando o wall-clock passa.
const NOW = new Date(Date.now()).toISOString();
const FRESH = new Date(Date.now() - 1 * 3_600_000).toISOString(); // 1h atrás (< 6h → fresh)
const STALE = new Date(Date.now() - 12 * 3_600_000).toISOString(); // 12h atrás (> 6h → stale)

describe("fetchEnrichedLhSet — pagina além do cap de 1000 do PostgREST", () => {
  it("agrega múltiplas páginas (1500 linhas → set de 1500)", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ lh: `LH${i}`, enriched_at: FRESH }));
    const set = await fetchEnrichedLhSet(makeEnrichedClient(rows), {});
    expect(set.size).toBe(1500);
    expect(set.has("LH0")).toBe(true);
    expect(set.has("LH1499")).toBe(true);
  });

  it("filtra por sinceIso (gte enriched_at)", async () => {
    const rows = [
      { lh: "A", enriched_at: FRESH },
      { lh: "B", enriched_at: STALE },
    ];
    const sinceIso = new Date(Date.now() - 6 * 3_600_000).toISOString(); // 6h atrás (entre FRESH e STALE)
    const set = await fetchEnrichedLhSet(makeEnrichedClient(rows), { sinceIso });
    expect(set.has("A")).toBe(true);
    expect(set.has("B")).toBe(false);
  });
});

describe("filterRowsToProcess — seleção do que (re)consultar", () => {
  const candidates = [{ lh: "A" }, { lh: "B" }, { lh: "C" }];
  // A = consultado e fresh; B = consultado e stale; C = nunca consultado
  const enriched = [
    { lh: "A", enriched_at: FRESH },
    { lh: "B", enriched_at: STALE },
  ];

  it("default (stale): processa stale (B) + nunca-consultado (C), pula fresh (A)", async () => {
    const out = await filterRowsToProcess(makeEnrichedClient(enriched), candidates, {});
    expect(out.map((r) => r.lh).sort()).toEqual(["B", "C"]);
  });

  it("onlyMissing: processa só quem nunca foi consultado (C)", async () => {
    const out = await filterRowsToProcess(makeEnrichedClient(enriched), candidates, { onlyMissing: true });
    expect(out.map((r) => r.lh)).toEqual(["C"]);
  });

  it("force: processa TODAS as linhas", async () => {
    const out = await filterRowsToProcess(makeEnrichedClient(enriched), candidates, { force: true });
    expect(out.map((r) => r.lh)).toEqual(["A", "B", "C"]);
  });

  it("force + forceSessionStart: pula o que já foi feito nesta sessão", async () => {
    // Suponha que A já foi enriquecido nesta sessão (enriched_at >= sessionStart).
    const sessionStart = new Date(Date.now() - 30 * 60_000).toISOString(); // 30min atrás
    const doneThisSession = [{ lh: "A", enriched_at: NOW }];
    const out = await filterRowsToProcess(makeEnrichedClient(doneThisSession), candidates, {
      force: true,
      forceSessionStart: sessionStart,
    });
    expect(out.map((r) => r.lh).sort()).toEqual(["B", "C"]);
  });
});

describe("matchAspxDriver — tolerante a acento e mojibake", () => {
  const aspx = indexAspxList([
    { cpf: "111", display_name: "JOSE MARIO DE OLIVEIRA" },
    { cpf: "222", display_name: "JANICLERTON FLORENCIO MAIA" },
    { cpf: "333", display_name: "MARIA DA SILVA" },
  ]);

  it("casa ignorando acento (José Mário → JOSE MARIO)", () => {
    expect(matchAspxDriver("José Mário de Oliveira", aspx)?.cpf).toBe("111");
  });
  it("casa mojibake ('?' = coringa): Jos? M?rio → JOSE MARIO", () => {
    expect(matchAspxDriver("Jos? M?rio de Oliveira", aspx)?.cpf).toBe("111");
    expect(matchAspxDriver("JANICLERTON FLOR?NCIO MAIA", aspx)?.cpf).toBe("222");
  });
  it("ignora placeholders (NOSHOW/AGREGADO) → null", () => {
    expect(matchAspxDriver("NOSHOW", aspx)).toBeNull();
    expect(matchAspxDriver("AGREGADO", aspx)).toBeNull();
  });
  it("não casa quem não está no diretório → null", () => {
    expect(matchAspxDriver("ZURIEL SCHWARZ", aspx)).toBeNull();
  });
});

const ctx = (over = {}) => ({
  driverByName: {},
  vehiclesByPlate: {},
  angelliraVehicles: {},
  ...over,
});

describe("buildEnrichedUpsertRow", () => {
  it("motorista no ASPX: grava cargo_id + cpf + display + Angellira", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:abc", cargoId: "abc", motoristas: "João Silva", cavalo: "", carreta: "" },
      ctx({
        driverByName: {
          "João Silva": {
            cpf: "12345", aspxFound: true, aspxDisplayName: "JOAO SILVA",
            angellira: { found: true, status: "FOUND", validUntil: "2027-01-01", statusText: "VIGENTE" },
          },
        },
      }),
    );
    expect(r.lh).toBe("cargo:abc");
    expect(r.cargo_id).toBe("abc");
    expect(r.aspx_cpf).toBe("12345");
    expect(r.aspx_display_name).toBe("JOAO SILVA");
    expect(r.angellira_driver_found).toBe(true);
    expect(r.angellira_driver_valid_until).toBe("2027-01-01");
  });

  it("motorista resolvido mas NÃO no ASPX (aspxFound=false): aspx_cpf null, mas Angellira vem", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:zz", cargoId: "zz", motoristas: "Maria", cavalo: "", carreta: "" },
      ctx({
        driverByName: {
          Maria: { cpf: "999", aspxFound: false, aspxDisplayName: null, angellira: { found: true, status: "FOUND", validUntil: "2028-01-01" } },
        },
      }),
    );
    expect(r.aspx_cpf).toBeNull(); // não está no ASPX → selo vermelho
    expect(r.angellira_driver_found).toBe(true); // Angellira ainda vem (do banco)
    expect(r.angellira_driver_valid_until).toBe("2028-01-01");
  });

  it("carrega nome+CPF do Angellira em angellira_driver_details (mesmo sem ASPX)", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:dd", cargoId: "dd", motoristas: "Silon", cavalo: "", carreta: "" },
      ctx({
        driverByName: {
          Silon: {
            cpf: "14086417472", aspxFound: false, aspxDisplayName: null,
            angellira: { found: true, status: "FOUND", validUntil: "2026-05-11", details: { name: "SILON BATISTA FILHO", cpf: "14086417472" } },
          },
        },
      }),
    );
    expect(r.aspx_cpf).toBeNull(); // não está no ASPX
    expect(r.angellira_driver_details).toEqual({ name: "SILON BATISTA FILHO", cpf: "14086417472" }); // CPF preservado p/ consulta
  });

  it("carga do sistema SEM motorista: linha esqueleto (cargo_id presente, campos null)", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:xyz", cargoId: "xyz", motoristas: "", cavalo: "", carreta: "" },
      ctx(),
    );
    expect(r.lh).toBe("cargo:xyz");
    expect(r.cargo_id).toBe("xyz");
    expect(r.driver_name).toBeNull();
    expect(r.aspx_cpf).toBeNull();
    expect(r.angellira_driver_found).toBeNull();
    expect(r.enriched_at).toBeTruthy(); // existe registro → não fica "não consultado"
  });

  it("linha da planilha: cargo_id null", () => {
    const r = buildEnrichedUpsertRow({ lh: "LT0Q6R0291RO1", motoristas: "", cavalo: "", carreta: "" }, ctx());
    expect(r.lh).toBe("LT0Q6R0291RO1");
    expect(r.cargo_id).toBeNull();
  });

  it("veículo do cache (db) é refletido", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:v", cargoId: "v", motoristas: "", cavalo: "ABC-1234", carreta: "" },
      ctx({ vehiclesByPlate: { ABC1234: { vehicle_type: "CARRETA", angellira_status: "FOUND", angellira_valid_until: "2027-01-01" } } }),
    );
    expect(r.cavalo_plate).toBe("ABC1234"); // normalizado
    expect(r.cavalo_source).toBe("db");
    expect(r.cavalo_angellira_found).toBe(true);
  });
});

describe("mergePreservingGood — não perde dado bom em falha transitória", () => {
  const prevFound = {
    lh: "LH1", driver_name: "João Silva", aspx_cpf: "123", aspx_display_name: "JOAO",
    angellira_driver_found: true, angellira_driver_status: "FOUND", angellira_driver_valid_until: "2027-01-01", angellira_driver_status_text: "VIGENTE",
    cavalo_plate: "ABC1234", cavalo_angellira_found: true, cavalo_angellira_status: "FOUND",
  };

  it("nova consulta UNAVAILABLE (mesmo motorista) → mantém o FOUND anterior", () => {
    const next = { lh: "LH1", driver_name: "João Silva", aspx_cpf: "123", angellira_driver_found: false, angellira_driver_status: "UNAVAILABLE", angellira_driver_valid_until: null, angellira_driver_status_text: null };
    const m = mergePreservingGood(next, prevFound);
    expect(m.angellira_driver_found).toBe(true);
    expect(m.angellira_driver_status).toBe("FOUND");
    expect(m.angellira_driver_valid_until).toBe("2027-01-01");
  });

  it("aspx_cpf sumiu (match ASPX falhou) mesmo motorista → mantém o cpf anterior", () => {
    const next = { lh: "LH1", driver_name: "João Silva", aspx_cpf: null, aspx_display_name: null, angellira_driver_status: null };
    const m = mergePreservingGood(next, prevFound);
    expect(m.aspx_cpf).toBe("123");
    expect(m.angellira_driver_found).toBe(true); // sem cpf → angellira null → preserva
  });

  it("motorista DIFERENTE → NÃO preserva (usa o novo, mesmo UNAVAILABLE)", () => {
    const next = { lh: "LH1", driver_name: "Outro Motorista", aspx_cpf: null, angellira_driver_found: false, angellira_driver_status: "UNAVAILABLE" };
    const m = mergePreservingGood(next, prevFound);
    expect(m.aspx_cpf).toBeNull();
    expect(m.angellira_driver_status).toBe("UNAVAILABLE");
  });

  it("nova consulta FOUND → usa o novo (atualiza)", () => {
    const next = { lh: "LH1", driver_name: "João Silva", aspx_cpf: "123", angellira_driver_found: true, angellira_driver_status: "FOUND", angellira_driver_valid_until: "2028-05-05" };
    const m = mergePreservingGood(next, prevFound);
    expect(m.angellira_driver_valid_until).toBe("2028-05-05");
  });

  it("cavalo UNAVAILABLE (mesma placa) → mantém o anterior", () => {
    const next = { lh: "LH1", driver_name: "X", cavalo_plate: "ABC1234", cavalo_angellira_found: false, cavalo_angellira_status: "UNAVAILABLE" };
    const m = mergePreservingGood(next, prevFound);
    expect(m.cavalo_angellira_found).toBe(true);
    expect(m.cavalo_angellira_status).toBe("FOUND");
  });

  it("sem registro anterior → retorna o novo", () => {
    const next = { lh: "LH9", driver_name: "Z", angellira_driver_status: "UNAVAILABLE" };
    expect(mergePreservingGood(next, undefined)).toBe(next);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildEnrichedUpsertRow,
  buildDriverHistoricoUpsertRows,
  buildDriverCpfFields,
  planForceLiveDriverWrites,
  mergePreservingGood,
  matchAspxDriver,
  driverNamesMatch,
  indexAspxList,
  fetchEnrichedLhSet,
  filterRowsToProcess,
} from "./sheet-monitor-enrichment.js";

describe("buildDriverCpfFields — consulta manual por CPF", () => {
  it("FOUND: grava status/validade e marca source=manual", () => {
    const f = buildDriverCpfFields("013.906.643-84", "MAGNO GABRIEL DOS SANTOS", {
      availability: "OK", found: true, status: "FOUND", statusText: "Conforme",
      validUntil: "2026-10-14", displayName: "MAGNO GABRIEL DOS SANTOS",
      driverDetails: { name: "MAGNO GABRIEL DOS SANTOS" },
    });
    expect(f.angellira_driver_found).toBe(true);
    expect(f.angellira_driver_valid_until).toBe("2026-10-14");
    expect(f.angellira_driver_details).toEqual({ name: "MAGNO GABRIEL DOS SANTOS", cpf: "01390664384", source: "manual" });
    expect(f.driver_name).toBe("MAGNO GABRIEL DOS SANTOS");
  });

  it("NOT_FOUND: found=false, sem validade, ainda marca source=manual", () => {
    const f = buildDriverCpfFields("01390664384", "FULANO", { availability: "OK", found: false, status: "NOT_FOUND" });
    expect(f.angellira_driver_found).toBe(false);
    expect(f.angellira_driver_valid_until).toBeNull();
    expect(f.angellira_driver_details).toMatchObject({ cpf: "01390664384", source: "manual" });
    expect(f.driver_name).toBe("FULANO");
  });
});

describe("planForceLiveDriverWrites — Consultar item (força ao vivo)", () => {
  const driverByName = {
    "MOTORISTA FOUND": { cpf: "11111111111", aspxFound: true, aspxDisplayName: "M FOUND" },
    "MOTORISTA NOT FOUND": { cpf: "22222222222", aspxFound: true, aspxDisplayName: "M NF" },
    "MOTORISTA INDISP": { cpf: "33333333333", aspxFound: true, aspxDisplayName: "M IND" },
  };
  const angelliraDrivers = {
    "11111111111": { availability: "OK", found: true, queryId: "q1", validUntil: "2026-10-14", lastSeenAt: "2026-07-01T00:00:00Z", driverDetails: { name: "M FOUND" } },
    "22222222222": { availability: "OK", found: false }, // NOT_FOUND autoritativo
    "33333333333": { availability: "UNAVAILABLE", found: false }, // API fora agora
  };
  const cpfs = ["11111111111", "22222222222", "33333333333"];

  it("FOUND vira upsert; NOT_FOUND vira clear; UNAVAILABLE fica de fora", () => {
    const { upserts, clears } = planForceLiveDriverWrites(driverByName, cpfs, angelliraDrivers);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].cpf).toBe("11111111111");
    expect(upserts[0].angelliraLimitDate).toBe("2026-10-14");
    expect(clears).toEqual(["22222222222"]); // UNAVAILABLE (333) NÃO entra
  });

  it("um CPF nunca aparece em upserts E clears ao mesmo tempo", () => {
    const { upserts, clears } = planForceLiveDriverWrites(driverByName, cpfs, angelliraDrivers);
    const inBoth = upserts.map((u) => u.cpf).filter((c) => clears.includes(c));
    expect(inBoth).toHaveLength(0);
  });
});

describe("buildDriverHistoricoUpsertRows — persiste consulta ao vivo p/ virar registro durável", () => {
  const angelliraDrivers = {
    "11111111111": { availability: "OK", found: true, queryId: "q1", validUntil: "2026-10-14", lastSeenAt: "2026-07-01T00:00:00Z", driverDetails: { name: "CARLEANDRO WAGNER" } },
    "22222222222": { availability: "OK", found: false, queryId: null, validUntil: null }, // NOT_FOUND
    "33333333333": { availability: "UNAVAILABLE", found: false }, // falha transitória
  };

  it("só persiste FOUND com availability OK que foi buscado agora (cpfsToFetch)", () => {
    const driverByName = {
      "CARLEANDRO WAGNER": { cpf: "11111111111", aspxFound: true, aspxDisplayName: "CARLEANDRO W" },
      "FULANO NOT FOUND": { cpf: "22222222222", aspxFound: true, aspxDisplayName: "FULANO" },
      "BELTRANO INDISPONIVEL": { cpf: "33333333333", aspxFound: true, aspxDisplayName: "BELTRANO" },
    };
    const rows = buildDriverHistoricoUpsertRows(driverByName, ["11111111111", "22222222222", "33333333333"], angelliraDrivers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cpf: "11111111111",
      nome: "CARLEANDRO WAGNER",
      angelliraQueryId: "q1",
      angelliraLimitDate: "2026-10-14",
      aspxFound: true,
    });
  });

  it("ignora motorista NÃO buscado agora (veio do cache/motoristas_historico)", () => {
    const driverByName = { "CARLEANDRO WAGNER": { cpf: "11111111111", aspxFound: true } };
    // cpfsToFetch vazio → nada foi consultado ao vivo → nada a persistir
    expect(buildDriverHistoricoUpsertRows(driverByName, [], angelliraDrivers)).toHaveLength(0);
  });

  it("dedup por CPF quando dois nomes resolvem o mesmo motorista", () => {
    const driverByName = {
      "CARLEANDRO WAGNER": { cpf: "11111111111", aspxFound: true },
      "CARLEANDRO W N RIBEIRO": { cpf: "11111111111", aspxFound: true },
    };
    expect(buildDriverHistoricoUpsertRows(driverByName, ["11111111111"], angelliraDrivers)).toHaveLength(1);
  });
});

describe("driverNamesMatch — mesma pessoa entre planilha e ASPX", () => {
  it("acento/caixa/espaço não separam a pessoa", () => {
    expect(driverNamesMatch("José da Silva", "JOSE DA SILVA")).toBe(true);
    expect(driverNamesMatch("  joão   silva ", "JOAO SILVA")).toBe(true);
  });
  it("conectivo (DE/DA/DOS) inserido/omitido não separa", () => {
    expect(driverNamesMatch("WESLEY ARAUJO SOARES", "WESLEY DE ARAUJO SOARES")).toBe(true);
    expect(driverNamesMatch("ANTONIO DOS SANTOS", "ANTONIO SANTOS")).toBe(true);
  });
  it("nome do meio a mais/menos (subconjunto, mesmo 1º e último) — default tolera 2 tokens", () => {
    expect(driverNamesMatch("MARIA CLARA SOUZA LIMA", "MARIA SOUZA LIMA")).toBe(true);
    expect(driverNamesMatch("JOAO SILVA", "JOAO PEDRO SILVA")).toBe(true);
  });
  it("reordenação dos MESMOS tokens não separa", () => {
    expect(driverNamesMatch("MARCELO SILVA SANTOS", "MARCELO SANTOS SILVA")).toBe(true);
    expect(driverNamesMatch("MARCOS JOSE DA SILVA", "JOSE MARCOS DA SILVA")).toBe(true);
  });
  it("modo ESTRITO (minSubsetTokens:3, diretório) — nome genérico de 2 tokens NÃO casa outra pessoa", () => {
    const s = { minSubsetTokens: 3 };
    expect(driverNamesMatch("MARCELO SANTOS SILVA", "MARCELO DA SILVA", s)).toBe(false);
    expect(driverNamesMatch("JOSE TEOFILO NOGUEIRA DOS SANTOS", "JOSE DOS SANTOS", s)).toBe(false);
    expect(driverNamesMatch("ALEX PEREIRA", "ALEX BARBOZA PEREIRA", s)).toBe(false);
    expect(driverNamesMatch("MARIA CLARA SOUZA LIMA", "MARIA SOUZA LIMA", s)).toBe(true); // 3 tokens ainda casa
  });
  it("token repetido não mascara diferença (multiset, não set)", () => {
    expect(driverNamesMatch("LEANDRO DOS SANTOS SANTOS", "LEANDRO FARIA DOS SANTOS")).toBe(false);
  });
  it("pessoas DIFERENTES não casam (evita esconder motorista trocado)", () => {
    expect(driverNamesMatch("NESTOR DE LIMA", "GABRIEL WESLEY MORAIS DE LIMA")).toBe(false); // só sobrenome
    expect(driverNamesMatch("ALEX CARNIO", "JOSE ROBERTO DE SANTANA")).toBe(false);
    expect(driverNamesMatch("JOAO SILVA", "JOAO SANTOS")).toBe(false); // 1º igual, resto não
    expect(driverNamesMatch("JOAO SILVA", "PEDRO SILVA")).toBe(false); // último igual, 1º não
  });
  it("vazio de qualquer lado → não casa", () => {
    expect(driverNamesMatch("", "JOAO")).toBe(false);
    expect(driverNamesMatch("JOAO", "")).toBe(false);
    expect(driverNamesMatch(null, undefined)).toBe(false);
  });
});

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

describe("matchAspxDriver — NÃO casa pessoas diferentes de mesmo 1º nome (bug MAGNO, LT0Q8102C34J1)", () => {
  const dir = indexAspxList([
    { cpf: "384", display_name: "MAGNO WELLINGTON CHAVES LIMA" },
    { cpf: "575", display_name: "MAGNO DO NASCIMENTO RODRIGUES" },
    { cpf: "505", display_name: "MAGNO GABRIEL DOS SANTOS" },
  ]);

  it("resolve o PRÓPRIO CPF quando o nome existe no diretório", () => {
    expect(matchAspxDriver("MAGNO GABRIEL DOS SANTOS", dir)?.cpf).toBe("505");
  });

  it("NÃO casa outra pessoa só pelo primeiro nome (retorna null, não o CPF errado)", () => {
    // Motorista fora deste diretório (ex.: só existe no aspx_drivers, não na
    // motoristas_historico). Antes o fallback startsWith('magno') casava WELLINGTON.
    const semGabriel = indexAspxList([
      { cpf: "384", display_name: "MAGNO WELLINGTON CHAVES LIMA" },
      { cpf: "575", display_name: "MAGNO DO NASCIMENTO RODRIGUES" },
    ]);
    expect(matchAspxDriver("MAGNO GABRIEL DOS SANTOS", semGabriel)).toBeNull();
  });

  it("não confunde primeiro nome no meio do outro (CARLOS MAGNO ≠ MAGNO ...)", () => {
    const dir2 = indexAspxList([{ cpf: "542", display_name: "CARLOS MAGNO SILVA SANTOS" }]);
    expect(matchAspxDriver("MAGNO GABRIEL DOS SANTOS", dir2)).toBeNull();
  });

  it("no diretório NÃO casa nome completo com nome genérico de 2 tokens (estrito)", () => {
    // Caso real: "MARCELO SANTOS SILVA" (planilha) não pode pegar "MARCELO DA SILVA".
    const dir3 = indexAspxList([
      { cpf: "1", display_name: "MARCELO DA SILVA" },
      { cpf: "2", display_name: "JOSE DOS SANTOS" },
    ]);
    expect(matchAspxDriver("MARCELO SANTOS SILVA", dir3)).toBeNull();
    expect(matchAspxDriver("JOSE TEOFILO NOGUEIRA DOS SANTOS", dir3)).toBeNull();
    // mas casa o próprio nome exato
    expect(matchAspxDriver("MARCELO DA SILVA", dir3)?.cpf).toBe("1");
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

  it("motorista deixou de casar (null, não UNAVAILABLE) → NÃO preserva (limpa dado que pode ser de OUTRA pessoa)", () => {
    // Matcher estrito rejeitou um match frouxo antigo: a nova passada não resolve o
    // motorista (status null). O dado anterior pode ser de outra pessoa → deve SAIR.
    const next = { lh: "LH1", driver_name: "João Silva", aspx_cpf: null, aspx_display_name: null, angellira_driver_found: null, angellira_driver_status: null };
    const m = mergePreservingGood(next, prevFound);
    expect(m.aspx_cpf).toBeNull();
    expect(m.angellira_driver_found).toBeNull();
    expect(m.angellira_driver_status).toBeNull();
  });

  it("mesmo nome de planilha mas OUTRO CPF (match frouxo antigo era de outra pessoa) → NÃO preserva", () => {
    // prevFound.aspx_cpf = "123" (pessoa A). A nova passada resolve o CPF "999"
    // (pessoa B, correta) e a API caiu (UNAVAILABLE). Não pode carregar o FOUND de A.
    const next = { lh: "LH1", driver_name: "João Silva", aspx_cpf: "999", angellira_driver_found: false, angellira_driver_status: "UNAVAILABLE", angellira_driver_valid_until: null };
    const m = mergePreservingGood(next, prevFound);
    expect(m.angellira_driver_found).toBe(false);
    expect(m.angellira_driver_status).toBe("UNAVAILABLE");
    expect(m.aspx_cpf).toBe("999");
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

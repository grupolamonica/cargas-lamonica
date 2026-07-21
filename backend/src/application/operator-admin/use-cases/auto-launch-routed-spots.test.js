import { describe, expect, it, vi } from "vitest";

import { autoLaunchRoutedSpots } from "./auto-launch-routed-spots.js";

// Linha normalizada do get-programacao (só os campos que a automação lê).
function row(lh, o = {}) {
  return {
    lh,
    tab: o.tab ?? "planejado",
    source: o.source ?? "spx-direct",
    motorista: o.motorista ?? "",
    podeLancar: o.podeLancar ?? (o.tab === "planejado"),
    isLinehaul: o.isLinehaul ?? true,
    expirada: o.expirada ?? false,
    jaLancada: o.jaLancada ?? false,
    origemCidadeUf: o.origemCidadeUf ?? "Criciuma Verdinho/SC",
    destinoCidadeUf: o.destinoCidadeUf ?? "Betim/MG",
    origem: o.origem ?? "Criciuma Verdinho/SC · SoC",
    destino: o.destino ?? "Betim/MG · LM Hub",
    data: o.data ?? "2026-07-20",
    horario: o.horario ?? "12:00",
    dataDescarga: o.dataDescarga ?? "2026-07-21",
    horarioDescarga: o.horarioDescarga ?? "15:00",
    nome: o.nome ?? "",
  };
}

// deps: getProgramacao (rows), fetchRouteCatalogMetricsByLoadId (Set de LHs com rota), launch (spy)
function makeDeps({ rows = [], routedLhs = new Set(), statusCode = 200, launch } = {}) {
  const launchCargoFromTrip = launch || vi.fn(async () => ({ payload: { alreadyExists: false, id: "cargo-1" } }));
  return {
    getProgramacao: vi.fn(async () => ({ statusCode, payload: { rows, error: statusCode === 200 ? undefined : "SPX_UNAVAILABLE" } })),
    fetchRouteCatalogMetricsByLoadId: vi.fn(async (_client, rrows) => {
      const m = new Map();
      for (const r of rrows) m.set(r.id, routedLhs.has(r.id) ? { valor_padrao: 1 } : null);
      return m;
    }),
    launchCargoFromTrip,
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  };
}

describe("autoLaunchRoutedSpots (DC-201)", () => {
  it("lança só os spots Planejado line-haul não-lançados COM rota cadastrada", async () => {
    const rows = [
      row("LT-A"), // planejado, linehaul, com rota → lança
      row("LT-B"), // planejado, linehaul, SEM rota → ignora
      row("LT-C", { jaLancada: true }), // já lançada → não é candidato
      row("XX-D", { isLinehaul: false }), // não line-haul → não é candidato
      row("LT-E", { expirada: true }), // atrasada → não é candidato
      row("LT-F", { tab: "aceito" }), // outra aba → não é candidato
    ];
    const deps = makeDeps({ rows, routedLhs: new Set(["LT-A"]) });
    const res = await autoLaunchRoutedSpots({ deps });

    expect(res.ok).toBe(true);
    expect(res.candidates).toBe(2); // LT-A e LT-B
    expect(res.routed).toBe(1); // só LT-A tem rota
    expect(res.launched).toBe(1);
    expect(deps.launchCargoFromTrip).toHaveBeenCalledTimes(1);
    // lança com Cidade/UF limpo (casa a rota) — nunca o rótulo "· TIPO".
    expect(deps.launchCargoFromTrip).toHaveBeenCalledWith(
      expect.objectContaining({ lh: "LT-A", origem: "Criciuma Verdinho/SC", destino: "Betim/MG" }),
    );
  });

  it("lança Nestlé aceita lançável (podeLancar) COM rota; ignora não-lançável, com motorista, morta, expirada e SPX", async () => {
    const rows = [
      // Nestlé aceita lançável, com rota → lança
      row("NES-A", { tab: "aceito", source: "nestle-galileu", podeLancar: true }),
      // Nestlé aceita lançável, SEM rota → candidato mas não routed
      row("NES-B", { tab: "aceito", source: "nestle-galileu", podeLancar: true }),
      // Nestlé aceita NÃO lançável (embarque morto / status desconhecido / com motorista)
      // → podeLancar=false → não é candidato (guarda dos achados MEDIUM/LOW da revisão)
      row("NES-DEAD", { tab: "aceito", source: "nestle-galileu", podeLancar: false }),
      // Nestlé aceita lançável mas EXPIRADA → excluída pela guarda genérica (achado LOW)
      row("NES-EXP", { tab: "aceito", source: "nestle-galileu", podeLancar: true, expirada: true }),
      // SPX/Shopee aceito (não-Nestlé) → nunca é candidato na aba aceito
      row("LT-ACC", { tab: "aceito", source: "spx-direct", podeLancar: false }),
    ];
    // NES-B sem rota (candidato mas não routed); DEAD/EXP COM rota, p/ provar que são
    // excluídos ANTES da rota (não basta ter rota — precisa ser lançável e não expirada).
    const deps = makeDeps({ rows, routedLhs: new Set(["NES-A", "NES-DEAD", "NES-EXP"]) });
    const res = await autoLaunchRoutedSpots({ deps });

    expect(res.ok).toBe(true);
    expect(res.candidates).toBe(2); // só NES-A e NES-B (lançáveis, não expiradas)
    expect(res.routed).toBe(1); // só NES-A tem rota
    expect(res.launched).toBe(1);
    expect(deps.launchCargoFromTrip).toHaveBeenCalledTimes(1);
    expect(deps.launchCargoFromTrip).toHaveBeenCalledWith(expect.objectContaining({ lh: "NES-A" }));
    // busca as abas planejado E aceito (senão não pega a Nestlé aceita)
    expect(deps.getProgramacao).toHaveBeenCalledWith(
      expect.objectContaining({ tabs: ["planejado", "aceito"] }),
    );
  });

  it("não aceita no SPX — só lança (nenhuma chamada de accept envolvida)", async () => {
    // A automação nem importa accept-aspx-trips; garantimos que só launch é chamado.
    const deps = makeDeps({ rows: [row("LT-A")], routedLhs: new Set(["LT-A"]) });
    await autoLaunchRoutedSpots({ deps });
    expect(deps.launchCargoFromTrip).toHaveBeenCalledTimes(1);
  });

  it("SPX indisponível (503) → no-op, não lança nada", async () => {
    const deps = makeDeps({ rows: [], statusCode: 503 });
    const res = await autoLaunchRoutedSpots({ deps });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("SPX_UNAVAILABLE");
    expect(res.launched).toBe(0);
    expect(deps.launchCargoFromTrip).not.toHaveBeenCalled();
  });

  it("respeita o teto por ciclo (maxPerRun) e reporta o deferido", async () => {
    const rows = [row("LT-A"), row("LT-B")];
    const deps = makeDeps({ rows, routedLhs: new Set(["LT-A", "LT-B"]) });
    const res = await autoLaunchRoutedSpots({ maxPerRun: 1, deps });
    expect(res.routed).toBe(2);
    expect(res.launched).toBe(1);
    expect(res.deferred).toBe(1);
    expect(deps.launchCargoFromTrip).toHaveBeenCalledTimes(1);
  });

  it("sem candidatos → no-op limpo", async () => {
    const deps = makeDeps({ rows: [row("LT-C", { jaLancada: true })] });
    const res = await autoLaunchRoutedSpots({ deps });
    expect(res.ok).toBe(true);
    expect(res.candidates).toBe(0);
    expect(res.launched).toBe(0);
    expect(deps.launchCargoFromTrip).not.toHaveBeenCalled();
  });
});

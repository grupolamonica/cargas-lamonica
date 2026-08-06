import { describe, expect, it } from "vitest";

import {
  carimboDeAceite,
  chaveDeGrupo,
  decidirCarga,
  escolherAceite,
  indexarOfertasPorGrupo,
  parseArgs,
  runBackfillTripAcceptedNestle,
} from "./backfill-trip-accepted-nestle.mjs";

// A decisão inteira vive nas funções PURAS. O I/O é fino de propósito, mas não é
// intestado: o bloco final roda o script de ponta a ponta contra um Supabase de
// mentira, porque as promessas que mais importam neste arquivo ("dry-run é o default",
// "idempotente", "nunca sobrescreve") são promessas de COMPORTAMENTO, não de pureza.

describe("parseArgs", () => {
  it("default: dry, sem limite", () => {
    expect(parseArgs([])).toEqual({ apply: false, limit: Infinity });
  });
  it("--apply e --limit=10", () => {
    expect(parseArgs(["--apply", "--limit=10"])).toEqual({ apply: true, limit: 10 });
  });

  // Antes isto virava Infinity em silêncio. Num script que escreve em produção, "não
  // entendi seu limite, então vou escrever tudo" é o pior default possível: quem digita
  // `--limit 5` (sem o "=") pedia 5 e levava 36.
  it("--limit ilegível ABORTA em vez de virar 'sem limite'", () => {
    expect(() => parseArgs(["--limit=abc"])).toThrow(/--limit precisa ser inteiro/);
    expect(() => parseArgs(["--limit=0"])).toThrow(/--limit precisa ser inteiro/);
    expect(() => parseArgs(["--limit=-3"])).toThrow(/--limit precisa ser inteiro/);
    expect(() => parseArgs(["--limit=2.5"])).toThrow(/--limit precisa ser inteiro/);
    expect(() => parseArgs(["--limit="])).toThrow(/--limit precisa ser inteiro/);
  });

  it("`--limit 5` (com espaço) aborta — não escorrega para 'escreve tudo'", () => {
    expect(() => parseArgs(["--apply", "--limit", "5"])).toThrow(/Argumento desconhecido/);
  });

  it("argumento desconhecido aborta (typo em --apply não vira execução silenciosa)", () => {
    expect(() => parseArgs(["--aply"])).toThrow(/Argumento desconhecido/);
    expect(() => parseArgs(["--force"])).toThrow(/Argumento desconhecido/);
  });
});

describe("chaveDeGrupo", () => {
  it("grupo único: só normaliza e apara", () => {
    expect(chaveDeGrupo("  b101474571 ")).toBe("B101474571");
  });

  it("multi-grupo casa literalmente quando a ordem é a mesma", () => {
    // Formato exato que o Galileu grava em grupos_id e que o operador digita no
    // lh_manual: "B101472521, B101472905" (medido em produção 06/08/2026).
    expect(chaveDeGrupo("B101472521, B101472905")).toBe("B101472521,B101472905");
  });

  it("multi-grupo casa mesmo com a ORDEM TROCADA", () => {
    // O motivo da chave ser ordenada: o Galileu grava o mesmo par nas duas ordens
    // ("B101458151, B101458214" e "B101458214, B101458151" convivem na tabela).
    // Sem canonizar, "B101472768, B101473232" ficaria órfã — foi o que aconteceu na
    // primeira sondagem antes desta regra existir.
    expect(chaveDeGrupo("B101473232, B101472768")).toBe(chaveDeGrupo("B101472768, B101473232"));
  });

  it("tolera separadores e espaçamento bagunçados do digitador", () => {
    expect(chaveDeGrupo("b101472768;  B101473232")).toBe("B101472768,B101473232");
    expect(chaveDeGrupo("B101472768 / B101473232")).toBe("B101472768,B101473232");
    expect(chaveDeGrupo("B101472768   B101473232")).toBe("B101472768,B101473232");
  });

  it("token repetido não duplica a chave", () => {
    expect(chaveDeGrupo("B101474571, B101474571")).toBe("B101474571");
  });

  it("vazio / só separadores / nulo → null (nunca vira chave que casa com alguém)", () => {
    expect(chaveDeGrupo("")).toBeNull();
    expect(chaveDeGrupo("   ")).toBeNull();
    expect(chaveDeGrupo(",  ;")).toBeNull();
    expect(chaveDeGrupo(null)).toBeNull();
    expect(chaveDeGrupo(undefined)).toBeNull();
  });

  it("LH Shopee vira chave mas nunca colide com grupo Nestlé", () => {
    expect(chaveDeGrupo("LT0Q8302CP7K1")).toBe("LT0Q8302CP7K1");
  });
});

describe("carimboDeAceite", () => {
  it("naive BRT vira instante UTC com offset fixo -03:00", () => {
    // 19:38 em São Paulo = 22:38Z. Ler como UTC atrasaria todo aceite em 3h.
    expect(carimboDeAceite("2026-08-03T19:38:00")).toBe("2026-08-03T22:38:00.000Z");
  });
  it("aceita a variante com espaço no lugar do T", () => {
    expect(carimboDeAceite("2026-08-03 19:38:00")).toBe("2026-08-03T22:38:00.000Z");
  });
  it("aceita sem os segundos", () => {
    expect(carimboDeAceite("2026-07-28T09:40")).toBe("2026-07-28T12:40:00.000Z");
  });
  it("vira o dia quando o aceite é de madrugada (a conta do fuso é real)", () => {
    expect(carimboDeAceite("2026-08-03T22:30:00")).toBe("2026-08-04T01:30:00.000Z");
  });
  it("ilegível / vazio / nulo → null (nunca inventa data)", () => {
    expect(carimboDeAceite("03/08/2026 19:38")).toBeNull();
    expect(carimboDeAceite("")).toBeNull();
    expect(carimboDeAceite(null)).toBeNull();
  });
});

const oferta = (over = {}) => ({
  codprogcoleta: "26009229",
  grupos_id: "B101474571",
  dtahraceite: "2026-08-03T15:53:00",
  descrstatprogcoleta: "EMBARQUE EMITIDO",
  ...over,
});

describe("escolherAceite", () => {
  it("oferta única com aceite é a escolhida", () => {
    expect(escolherAceite([oferta()]).codprogcoleta).toBe("26009229");
  });

  it("descarta oferta sem dtahraceite", () => {
    expect(escolherAceite([oferta({ dtahraceite: null })])).toBeNull();
    expect(escolherAceite([])).toBeNull();
    expect(escolherAceite(null)).toBeNull();
  });

  it("oferta VIVA ganha da morta mesmo sendo mais recente", () => {
    // Padrão medido: uma DECLINADA antiga convivendo com a EMBARQUE EMITIDO que de
    // fato valeu (5 chaves em produção). A viva é a que conta.
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "25188143", dtahraceite: "2026-06-01T17:25:00", descrstatprogcoleta: "DECLINADA" }),
      oferta({ codprogcoleta: "25576891", dtahraceite: "2026-06-30T14:45:00", descrstatprogcoleta: "EMBARQUE EMITIDO" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("25576891");
  });

  it("só mortas: o aceite ainda vale (CANCELADO não desfaz aceite histórico)", () => {
    // 5 cargas lançadas em produção têm a oferta CANCELADO com dtahraceite
    // preenchido. O aceite aconteceu; `trip_accepted_at` é fato que não se desfaz.
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "26010060", dtahraceite: "2026-08-03T10:45:00", descrstatprogcoleta: "CANCELADO" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("26010060");
  });

  it("empate entre vivas: fica o aceite mais ANTIGO ('desde quando sabemos')", () => {
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "B", dtahraceite: "2026-08-04T10:00:00" }),
      oferta({ codprogcoleta: "A", dtahraceite: "2026-08-03T10:00:00" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("A");
  });

  it("mesmo carimbo em duas ofertas: desempate por codprogcoleta (saída determinística)", () => {
    const entrada = [
      oferta({ codprogcoleta: "26009999" }),
      oferta({ codprogcoleta: "26009111" }),
    ];
    expect(escolherAceite(entrada).codprogcoleta).toBe("26009111");
    expect(escolherAceite([...entrada].reverse()).codprogcoleta).toBe("26009111");
  });

  it("não muta a lista recebida", () => {
    const entrada = [oferta({ codprogcoleta: "Z", dtahraceite: "2026-08-04T10:00:00" }), oferta({ codprogcoleta: "A" })];
    escolherAceite(entrada);
    expect(entrada[0].codprogcoleta).toBe("Z");
  });

  // ─── C-7: ordenar TEXTO CRU escolhia o aceite errado ────────────────────────
  // O Galileu produz duas formas ('…T08:00' e '… 09:00:00') e `carimboDeAceite` aceita
  // as duas justamente por isso. Ordenando texto, elas divergem na posição 10 — espaço
  // (0x20) vem ANTES de 'T' (0x54) — então a das 09:00 era considerada a mais antiga e
  // o script gravaria em produção uma hora que nunca existiu. Agora a ordem é pelo
  // instante parseado, então a forma do texto não influi.
  it("formas MISTAS no mesmo grupo: vence o mais antigo de verdade, não o que o texto sugere", () => {
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "espaco", dtahraceite: "2026-08-01 09:00:00" }),
      oferta({ codprogcoleta: "com-T", dtahraceite: "2026-08-01T08:00" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("com-T");
    expect(carimboDeAceite(escolhida.dtahraceite)).toBe("2026-08-01T11:00:00.000Z");
  });

  it("formas mistas: o resultado não depende da ordem de entrada", () => {
    const entrada = [
      oferta({ codprogcoleta: "espaco", dtahraceite: "2026-08-01 09:00:00" }),
      oferta({ codprogcoleta: "com-T", dtahraceite: "2026-08-01T08:00" }),
    ];
    expect(escolherAceite([...entrada].reverse()).codprogcoleta).toBe("com-T");
  });

  it("MESMO instante escrito nas duas formas: empata e cai no desempate estável", () => {
    // Com ordenação textual isto NÃO era empate (strings diferentes), então a saída
    // dependia da ordem em que o PostgREST devolveu as linhas.
    const entrada = [
      oferta({ codprogcoleta: "26009999", dtahraceite: "2026-08-01 09:00:00" }),
      oferta({ codprogcoleta: "26009111", dtahraceite: "2026-08-01T09:00:00" }),
    ];
    expect(escolherAceite(entrada).codprogcoleta).toBe("26009111");
    expect(escolherAceite([...entrada].reverse()).codprogcoleta).toBe("26009111");
  });

  it("carimbo ILEGÍVEL no meio: é ignorado, não é escolhido nem atrapalha a ordem", () => {
    // "03/08/2026 …" ordenaria antes de qualquer "2026-…" no texto ('0' < '2') e seria
    // eleito o "mais antigo" — gravando um carimbo que o parse devolve como null.
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "lixo", dtahraceite: "03/08/2026 07:00" }),
      oferta({ codprogcoleta: "boa", dtahraceite: "2026-08-01T08:00:00" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("boa");
    expect(carimboDeAceite(escolhida.dtahraceite)).not.toBeNull();
  });

  it("todas ilegíveis → null (não elege nada; a carga fica SEM_OFERTA_NESTLE)", () => {
    expect(escolherAceite([oferta({ dtahraceite: "03/08/2026 07:00" }), oferta({ dtahraceite: "sem data" })])).toBeNull();
  });

  it("oferta VIVA com carimbo ilegível não segura a vaga da morta legível", () => {
    // A viva não tem aceite que saibamos ler; então quem responde é a morta legível.
    const escolhida = escolherAceite([
      oferta({ codprogcoleta: "viva-ilegivel", dtahraceite: "ontem", descrstatprogcoleta: "EMBARQUE EMITIDO" }),
      oferta({ codprogcoleta: "morta-legivel", dtahraceite: "2026-08-01T08:00:00", descrstatprogcoleta: "CANCELADO" }),
    ]);
    expect(escolhida.codprogcoleta).toBe("morta-legivel");
  });
});

describe("indexarOfertasPorGrupo", () => {
  it("indexa pela chave canônica e resolve a ordem trocada do multi-grupo", () => {
    const idx = indexarOfertasPorGrupo([
      oferta({ codprogcoleta: "1", grupos_id: "B101473232, B101472768", dtahraceite: "2026-08-03T18:25:00" }),
    ]);
    expect(idx.get(chaveDeGrupo("B101472768, B101473232")).codprogcoleta).toBe("1");
  });

  it("grupo sem nenhum aceite não entra no índice", () => {
    const idx = indexarOfertasPorGrupo([oferta({ dtahraceite: null })]);
    expect(idx.size).toBe(0);
  });

  it("grupos_id vazio é ignorado (não vira chave-lixo)", () => {
    const idx = indexarOfertasPorGrupo([oferta({ grupos_id: "  " }), oferta({ grupos_id: null })]);
    expect(idx.size).toBe(0);
  });

  it("agrupa várias ofertas do mesmo grupo antes de escolher", () => {
    const idx = indexarOfertasPorGrupo([
      oferta({ codprogcoleta: "morta", dtahraceite: "2026-07-15T14:11:00", descrstatprogcoleta: "DECLINADA" }),
      oferta({ codprogcoleta: "viva", dtahraceite: "2026-07-16T14:19:00", descrstatprogcoleta: "EMBARQUE EMITIDO" }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("B101474571").codprogcoleta).toBe("viva");
  });
});

describe("decidirCarga", () => {
  const ofertaPorChave = indexarOfertasPorGrupo([
    oferta({ codprogcoleta: "26009229", grupos_id: "B101474571", dtahraceite: "2026-08-03T15:53:00" }),
    oferta({ codprogcoleta: "26009210", grupos_id: "B101474062, B101473360", dtahraceite: "2026-08-03T18:04:00" }),
  ]);
  const carga = (over = {}) => ({ id: "c1", lh_manual: "B101474571", status: "OPEN", trip_accepted_at: null, ...over });

  it("casa e manda MARCAR com o carimbo REAL do aceite (não now())", () => {
    const d = decidirCarga({ carga: carga(), ofertaPorChave });
    expect(d).toMatchObject({ classe: "MARCAR", chave: "B101474571", carimbo: "2026-08-03T18:53:00.000Z" });
    expect(d.oferta.codprogcoleta).toBe("26009229");
  });

  it("multi-grupo digitado em outra ordem também casa", () => {
    const d = decidirCarga({ carga: carga({ lh_manual: "B101473360, B101474062" }), ofertaPorChave });
    expect(d.classe).toBe("MARCAR");
    expect(d.oferta.codprogcoleta).toBe("26009210");
  });

  it("já marcada → JA_MARCADA (nunca sobrescreve; é o que torna a 2ª passada um no-op)", () => {
    const d = decidirCarga({ carga: carga({ trip_accepted_at: "2026-08-05T12:00:00.000Z" }), ofertaPorChave });
    expect(d).toMatchObject({ classe: "JA_MARCADA", carimbo: null });
  });

  it("já marcada tem precedência sobre não casar (não reclassifica o que está pronto)", () => {
    const d = decidirCarga({
      carga: carga({ lh_manual: "LT0Q8302CP7K1", trip_accepted_at: "2026-08-05T12:00:00.000Z" }),
      ofertaPorChave,
    });
    expect(d.classe).toBe("JA_MARCADA");
  });

  it("carga Shopee nunca casa — é assim que o escopo 'só Nestlé' se fecha", () => {
    const d = decidirCarga({ carga: carga({ lh_manual: "LT0Q8302CP7K1" }), ofertaPorChave });
    expect(d).toMatchObject({ classe: "SEM_OFERTA_NESTLE", carimbo: null, oferta: null });
  });

  it("LH de teste (FAKE/FEKE/FK5/fila) fica SEM_OFERTA_NESTLE — são as 11 órfãs de produção", () => {
    for (const lh of ["FAKE", "FAKE 00", "FEKE 2", "FK13", "fila 67"]) {
      expect(decidirCarga({ carga: carga({ lh_manual: lh }), ofertaPorChave }).classe).toBe("SEM_OFERTA_NESTLE");
    }
  });

  it("grupo Nestlé sem oferta com aceite → SEM_OFERTA_NESTLE (fica visível, não escondida)", () => {
    const d = decidirCarga({ carga: carga({ lh_manual: "B101999999" }), ofertaPorChave });
    expect(d.classe).toBe("SEM_OFERTA_NESTLE");
  });

  it("lh_manual em branco → SEM_LH (defensivo; o SELECT já filtra)", () => {
    expect(decidirCarga({ carga: carga({ lh_manual: "  " }), ofertaPorChave }).classe).toBe("SEM_LH");
    expect(decidirCarga({ carga: carga({ lh_manual: null }), ofertaPorChave }).classe).toBe("SEM_LH");
  });

  it("a lápide (aposentada) também é decidida — o fato histórico vale para ela", () => {
    const d = decidirCarga({ carga: carga({ retired_reason: "twin_taken" }), ofertaPorChave });
    expect(d.classe).toBe("MARCAR");
  });

  // ─── checked_at é "última observação conclusiva" — não pode andar para trás ──
  it("sem checked_at prévio: as duas colunas recebem o MESMO carimbo real", () => {
    const d = decidirCarga({ carga: carga(), ofertaPorChave });
    expect(d.carimboChecked).toBe(d.carimbo);
    expect(d.carimbo).toBe("2026-08-03T18:53:00.000Z");
  });

  it("checked_at prévio MAIS RECENTE é preservado (não envelhecemos observação alheia)", () => {
    const d = decidirCarga({
      carga: carga({ trip_acceptance_checked_at: "2026-08-06T10:00:00.000Z" }),
      ofertaPorChave,
    });
    expect(d.carimbo).toBe("2026-08-03T18:53:00.000Z"); // aceite: o instante histórico
    expect(d.carimboChecked).toBe("2026-08-06T10:00:00.000Z"); // observação: a mais fresca
  });

  it("checked_at prévio mais ANTIGO avança para o nosso carimbo", () => {
    const d = decidirCarga({
      carga: carga({ trip_acceptance_checked_at: "2026-07-01T10:00:00.000Z" }),
      ofertaPorChave,
    });
    expect(d.carimboChecked).toBe("2026-08-03T18:53:00.000Z");
  });

  it("checked_at prévio como Date (driver pg) é entendido igual", () => {
    const d = decidirCarga({
      carga: carga({ trip_acceptance_checked_at: new Date("2026-08-06T10:00:00.000Z") }),
      ofertaPorChave,
    });
    expect(d.carimboChecked).toBe("2026-08-06T10:00:00.000Z");
  });

  it("checked_at prévio ilegível é tratado como 'nunca checado' (cai no nosso carimbo)", () => {
    const d = decidirCarga({ carga: carga({ trip_acceptance_checked_at: "vixe" }), ofertaPorChave });
    expect(d.carimboChecked).toBe("2026-08-03T18:53:00.000Z");
  });
});

// ─── Fim a fim, contra um Supabase de mentira ─────────────────────────────────
//
// Reproduz só o que o script usa da API do PostgREST: from().select() + os filtros
// .is/.not, .order(), .range() na leitura; from().update().eq().is().select() na
// escrita. É pouca coisa e paga por si — as promessas verificadas aqui (dry-run é o
// default, --limit corta, compare-and-set, segunda passada não escreve) são
// exatamente as que ninguém quer descobrir erradas com o banco de produção aberto.

function criarSupabaseFake({ ofertas = [], cargas = [] } = {}) {
  const linhas = { nestle_ofertas: ofertas.map((o) => ({ ...o })), cargas: cargas.map((c) => ({ ...c })) };
  const updates = [];

  const consulta = (tabela) => {
    let atual = [...linhas[tabela]];
    const q = {
      is(col, val) {
        if (val === null) atual = atual.filter((l) => l[col] == null);
        return q;
      },
      not(col, op, val) {
        if (op === "is" && val === null) atual = atual.filter((l) => l[col] != null);
        return q;
      },
      order(col) {
        atual = [...atual].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
        return q;
      },
      range(ini, fim) {
        return Promise.resolve({ data: atual.slice(ini, fim + 1), error: null });
      },
    };
    return q;
  };

  const mutacao = (tabela, patch) => {
    let alvo = [...linhas[tabela]];
    const m = {
      eq(col, val) {
        alvo = alvo.filter((l) => l[col] === val);
        return m;
      },
      is(col, val) {
        if (val === null) alvo = alvo.filter((l) => l[col] == null);
        return m;
      },
      select() {
        for (const l of alvo) Object.assign(l, patch);
        updates.push({ tabela, patch, ids: alvo.map((l) => l.id) });
        return Promise.resolve({ data: alvo.map((l) => ({ id: l.id })), error: null });
      },
    };
    return m;
  };

  return {
    updates,
    linhas,
    from: (tabela) => ({ select: () => consulta(tabela), update: (patch) => mutacao(tabela, patch) }),
  };
}

describe("runBackfillTripAcceptedNestle", () => {
  const cenario = () => ({
    ofertas: [
      { codprogcoleta: "1", grupos_id: "B101474571", dtahraceite: "2026-08-03T15:53:00", descrstatprogcoleta: "EMBARQUE EMITIDO" },
      { codprogcoleta: "2", grupos_id: "B101474062, B101473360", dtahraceite: "2026-08-03T18:04:00", descrstatprogcoleta: "EMBARQUE EMITIDO" },
      { codprogcoleta: "3", grupos_id: "B101999000", dtahraceite: null, descrstatprogcoleta: "EM ABERTO" },
    ],
    cargas: [
      { id: "a", sheet_lh: null, lh_manual: "B101474571", status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null },
      { id: "b", sheet_lh: null, lh_manual: "B101473360, B101474062", status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null },
      { id: "c", sheet_lh: null, lh_manual: "LT0Q8302CP7K1", status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null },
      { id: "d", sheet_lh: null, lh_manual: "B101474571", status: "OPEN", trip_accepted_at: "2026-08-05T12:00:00.000Z", trip_acceptance_checked_at: null },
      { id: "e", sheet_lh: "LT9999", lh_manual: null, status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null },
    ],
  });

  it("DRY-RUN é o default: decide tudo e NÃO escreve uma linha sequer", async () => {
    const supabaseClient = criarSupabaseFake(cenario());
    const r = await runBackfillTripAcceptedNestle({ apply: false, limit: Infinity, deps: { supabaseClient } });

    expect(supabaseClient.updates).toHaveLength(0);
    expect(r.gravados).toBe(0);
    expect(r.candidatos).toBe(2);
    expect(r.agregado).toMatchObject({ MARCAR: 2, SEM_OFERTA_NESTLE: 1, JA_MARCADA: 1 });
    expect(supabaseClient.linhas.cargas.find((c) => c.id === "a").trip_accepted_at).toBeNull();
  });

  it("a carga com sheet_lh (planilha) nem é lida — só lançadas entram na varredura", async () => {
    const supabaseClient = criarSupabaseFake(cenario());
    const r = await runBackfillTripAcceptedNestle({ apply: false, limit: Infinity, deps: { supabaseClient } });
    expect(r.totalLancadas).toBe(4);
    expect(r.relatorio.map((l) => l.id)).not.toContain("e");
  });

  it("--apply grava o carimbo REAL nas duas colunas, e só nos candidatos", async () => {
    const supabaseClient = criarSupabaseFake(cenario());
    const r = await runBackfillTripAcceptedNestle({ apply: true, limit: Infinity, deps: { supabaseClient } });

    expect(r.gravados).toBe(2);
    const a = supabaseClient.linhas.cargas.find((c) => c.id === "a");
    expect(a.trip_accepted_at).toBe("2026-08-03T18:53:00.000Z");
    expect(a.trip_acceptance_checked_at).toBe("2026-08-03T18:53:00.000Z");
    // multi-grupo em ordem trocada casou
    expect(supabaseClient.linhas.cargas.find((c) => c.id === "b").trip_accepted_at).toBe("2026-08-03T21:04:00.000Z");
    // Shopee intocada
    expect(supabaseClient.linhas.cargas.find((c) => c.id === "c").trip_accepted_at).toBeNull();
    // já marcada intocada (o carimbo dela continua o que era)
    expect(supabaseClient.linhas.cargas.find((c) => c.id === "d").trip_accepted_at).toBe("2026-08-05T12:00:00.000Z");
  });

  it("IDEMPOTENTE: a segunda passada com --apply não escreve nada", async () => {
    const supabaseClient = criarSupabaseFake(cenario());
    await runBackfillTripAcceptedNestle({ apply: true, limit: Infinity, deps: { supabaseClient } });
    const antes = JSON.stringify(supabaseClient.linhas.cargas);
    supabaseClient.updates.length = 0;

    const r2 = await runBackfillTripAcceptedNestle({ apply: true, limit: Infinity, deps: { supabaseClient } });

    expect(supabaseClient.updates).toHaveLength(0);
    expect(r2.gravados).toBe(0);
    expect(r2.candidatos).toBe(0);
    expect(r2.agregado.JA_MARCADA).toBe(3);
    expect(JSON.stringify(supabaseClient.linhas.cargas)).toBe(antes);
  });

  it("--limit corta os CANDIDATOS (não a varredura) e sinaliza truncado", async () => {
    const supabaseClient = criarSupabaseFake(cenario());
    const r = await runBackfillTripAcceptedNestle({ apply: true, limit: 1, deps: { supabaseClient } });

    expect(r.totalLancadas).toBe(4); // varreu tudo: o relatório não fica enviesado
    expect(r.candidatos).toBe(2);
    expect(r.processados).toBe(1);
    expect(r.truncado).toBe(true);
    expect(r.gravados).toBe(1);
    expect(supabaseClient.updates).toHaveLength(1);
    expect(r.agregado.FORA_DO_LIMIT).toBe(1);
  });

  it("compare-and-set: quem foi marcada entre a leitura e o UPDATE vira PERDEU_A_CORRIDA", async () => {
    const dados = cenario();
    const supabaseClient = criarSupabaseFake(dados);
    // simula o job ao vivo marcando a carga "a" depois que já a lemos
    const original = supabaseClient.from;
    let leu = false;
    supabaseClient.from = (tabela) => {
      const api = original(tabela);
      return {
        select: (...args) => {
          const q = api.select(...args);
          if (tabela === "cargas") leu = true;
          return q;
        },
        update: (patch) => {
          if (leu) supabaseClient.linhas.cargas.find((c) => c.id === "a").trip_accepted_at = "2026-08-06T09:00:00.000Z";
          return api.update(patch);
        },
      };
    };

    const r = await runBackfillTripAcceptedNestle({ apply: true, limit: Infinity, deps: { supabaseClient } });

    expect(r.agregado.PERDEU_A_CORRIDA).toBe(1);
    // a observação mais fresca do job prevaleceu
    expect(supabaseClient.linhas.cargas.find((c) => c.id === "a").trip_accepted_at).toBe("2026-08-06T09:00:00.000Z");
  });

  it("INVARIANTE: nenhuma escrita deixa checked_at preenchido com accepted_at nulo", async () => {
    // É a combinação exata que ESCONDE a linha no Monitor. Este script pode errar de
    // muitos jeitos; escondendo carga do operador, não.
    const dados = cenario();
    dados.ofertas.push({ codprogcoleta: "4", grupos_id: "B101555555", dtahraceite: "data ilegível", descrstatprogcoleta: "EMBARQUE EMITIDO" });
    dados.cargas.push({ id: "f", sheet_lh: null, lh_manual: "B101555555", status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null });
    const supabaseClient = criarSupabaseFake(dados);

    await runBackfillTripAcceptedNestle({ apply: true, limit: Infinity, deps: { supabaseClient } });

    for (const u of supabaseClient.updates) {
      expect(u.patch.trip_accepted_at).toBeTruthy();
      expect(u.patch.trip_acceptance_checked_at).toBeTruthy();
    }
    const f = supabaseClient.linhas.cargas.find((c) => c.id === "f");
    expect(f.trip_acceptance_checked_at).toBeNull();
    expect(f.trip_accepted_at).toBeNull();
  });

  it("lê além de 1000 linhas — o teto do PostgREST não pode truncar a população", async () => {
    // O comentário de `lerPaginado` promete isso; sem teste, a promessa é um post-it.
    const ofertas = [];
    const cargas = [];
    for (let i = 0; i < 1200; i += 1) {
      const grupo = `B${String(101000000 + i)}`;
      ofertas.push({ codprogcoleta: String(i).padStart(6, "0"), grupos_id: grupo, dtahraceite: "2026-08-03T15:53:00", descrstatprogcoleta: "EMBARQUE EMITIDO" });
      cargas.push({ id: String(i).padStart(6, "0"), sheet_lh: null, lh_manual: grupo, status: "OPEN", trip_accepted_at: null, trip_acceptance_checked_at: null });
    }
    const supabaseClient = criarSupabaseFake({ ofertas, cargas });

    const r = await runBackfillTripAcceptedNestle({ apply: false, limit: Infinity, deps: { supabaseClient } });

    expect(r.totalOfertasComAceite).toBe(1200);
    expect(r.totalLancadas).toBe(1200);
    expect(r.candidatos).toBe(1200);
  });

  it("erro de coluna ausente vira mensagem que diz qual migration aplicar", async () => {
    const supabaseClient = {
      from: () => ({
        select: () => ({
          is: function () { return this; },
          not: function () { return this; },
          order: function () { return this; },
          range: () => Promise.resolve({ data: null, error: { message: "column cargas.trip_acceptance_checked_at does not exist" } }),
        }),
      }),
    };
    await expect(runBackfillTripAcceptedNestle({ apply: false, limit: Infinity, deps: { supabaseClient } })).rejects.toThrow(
      /20260806150000/,
    );
  });
});

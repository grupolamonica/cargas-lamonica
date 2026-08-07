import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isOfferedToDriver } from "../../../domain/operator-admin/driver-offer-visibility.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import { closeTestDatabase, query, resetTestDatabase, seedCargo, seedCliente, seedPacote } from "../test-harness.js";
import { buildDriverLoadFilters } from "./_shared.js";

// TESTE ANTI-DIVERGÊNCIA — o mais importante do portão.
//
// `isOfferedToDriver` é um espelho, em JavaScript, do WHERE que o portal do motorista
// monta em `buildDriverLoadFilters`. Espelho copiado à mão diverge: alguém muda a regra
// de um lado, o outro fica para trás, e a divergência aparece meses depois como carga
// ofertada invisível ao operador — que é exatamente o incidente que o portão existe
// para impedir. Um teste que só afirmasse o texto do SQL, ou que reimplementasse a
// regra numa terceira cópia, não pegaria nada disso.
//
// Então este teste não olha código: monta um conjunto de cargas cobrindo as fronteiras,
// roda o SQL REAL do `buildDriverLoadFilters` contra o harness pg-mem, roda o predicado
// JS sobre as MESMAS linhas e compara CONJUNTOS DE IDS.
//
// A relação afirmada não é igualdade cega, e sim a igualdade mais a lista FECHADA de
// divergências deliberadas (hoje: uma). O predicado é, por projeto, um superconjunto do
// SQL — "desconhecido nunca bloqueia". Afirmar `JS ⊇ SQL` sozinho seria frouxo demais
// (um predicado que devolvesse sempre `true` passaria); por isso afirmamos também que
// `JS \ SQL` é EXATAMENTE o caso documentado. Qualquer divergência nova quebra o teste.

/** Recorte do portal em runtime: visibilidade + pacote + guarda do ASPX + exceção
 *  "a confirmar" — a mesma configuração que `fetchDriverLoadsReadModel` usa. */
const OPCOES_DO_PORTAL = {
  includeDriverVisibilityFilter: true,
  includePacoteVisibilityFilter: true,
};

// Deslocamentos derivados do relógio REAL (o `buildDriverLoadFilters` lê
// `getSaoPauloWallClock()` por dentro, sem injeção). Passar pelo relógio em vez de somar
// horas na string resolve a virada de dia sozinho: às 00:10 BRT, "90 min atrás" vira
// ontem 22:40 — que continua sendo passado tanto para o SQL quanto para o JS.
const MIN = 60_000;
const passado = getSaoPauloWallClock(new Date(Date.now() - 90 * MIN));
const futuro = getSaoPauloWallClock(new Date(Date.now() + 90 * MIN));

describe.sequential("paridade: isOfferedToDriver × WHERE real do portal (pg-mem)", () => {
  /** nome legível → id, para a mensagem de falha dizer QUAL fronteira divergiu. */
  const nomePorId = new Map();
  let idDanglingPacote;

  /** Cria a carga e aplica as colunas que o `seedCargo` não expõe. */
  async function criar(nome, overrides = {}, extras = {}) {
    const { id } = await seedCargo({ sheet_lh: null, ...overrides });
    if (Object.keys(extras).length > 0) {
      const cols = Object.keys(extras);
      await query(
        `UPDATE public.cargas SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [id, ...cols.map((c) => extras[c])],
      );
    }
    nomePorId.set(id, nome);
    return id;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    const clienteId = (await seedCliente({ nome: "Shopee" })).id;
    const base = { cliente_id: clienteId, status: "OPEN", driver_visibility: "PUBLIC", data: futuro.dateIso, horario: futuro.timeIso };

    const pacotePublicado = (await seedPacote({ status: "publicado" })).id;
    const pacoteEmAndamento = (await seedPacote({ status: "em_andamento" })).id;
    const pacoteRascunho = (await seedPacote({ status: "rascunho" })).id;

    // ── ciclo de vida ──
    await criar("aberta-simples", { ...base });
    for (const status of ["DRAFT", "BOOKED", "RESERVED", "CANCELLED", "EXPIRED"]) {
      await criar(`ciclo-${status}`, { ...base, status });
    }

    // ── template ──
    await criar("template", { ...base, is_template: true });

    // ── alocação efetiva (COALESCE(alloc, sheet, '')) ──
    await criar("com-alloc-motorista", { ...base }, { alloc_motorista: "ANA" });
    await criar("com-sheet-motorista", { ...base }, { sheet_motorista: "JOÃO" });
    // Override VAZIO do operador vence a planilha: o COALESCE para no '' e a carga volta
    // a ser oferta — fronteira que um `||` em JS erraria.
    await criar("alloc-vazio-vence-sheet", { ...base }, { alloc_motorista: "", sheet_motorista: "JOÃO" });
    // '   ' <> '' no Postgres: um `.trim()` no predicado divergiria bem aqui.
    await criar("alloc-em-brancos", { ...base }, { alloc_motorista: "   " });

    // ── viagem fora do ASPX ──
    await criar("fora-do-aspx", { ...base }, { aspx_missing_since: new Date().toISOString() });

    // ── janela de carregamento ──
    await criar("data-passada", { ...base, data: passado.dateIso, horario: "00:00:00" });
    await criar("hoje-antes-de-agora", { ...base, data: passado.dateIso, horario: passado.timeIso });
    await criar("hoje-depois-de-agora", { ...base, data: futuro.dateIso, horario: futuro.timeIso });
    await criar("agenda-a-confirmar-vencida", { ...base, data: passado.dateIso, horario: "00:00:00" }, { agenda_a_confirmar: true });

    // ── visibilidade da carga avulsa ──
    await criar("privada", { ...base, driver_visibility: "PRIVATE" });

    // ── perna de pacote ──
    await criar("pacote-publicado", { ...base, viagem_id: pacotePublicado, ordem_viagem: 1 });
    await criar("pacote-em-andamento", { ...base, viagem_id: pacoteEmAndamento, ordem_viagem: 1 });
    await criar("pacote-rascunho", { ...base, viagem_id: pacoteRascunho, ordem_viagem: 1 });
    // PREMIUM dentro de pacote publicado: o pacote manda, `driver_visibility` é ignorado.
    await criar("pacote-publicado-mas-privada", {
      ...base, viagem_id: pacotePublicado, ordem_viagem: 2, driver_visibility: "PRIVATE",
    });
    // Divergência DELIBERADA (a única): pacote que não existe. O SQL usa LEFT JOIN e
    // reprova por `NULL IN (...)`; o JS trata pacote desconhecido como ofertado.
    idDanglingPacote = await criar("pacote-inexistente", {
      ...base, viagem_id: "99999999-9999-4999-8999-999999999999", ordem_viagem: 1,
    });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  /** Ids aprovados pelo WHERE REAL do portal, executado no banco do harness. */
  async function idsAprovadosPeloSql() {
    const { whereSql, values } = buildDriverLoadFilters({}, OPCOES_DO_PORTAL);
    const { rows } = await query(
      `SELECT cargas.id::text AS id
         FROM public.cargas
         LEFT JOIN public.cargas_casadas cc ON cc.id = cargas.viagem_id
        WHERE ${whereSql}`,
      values,
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Ids aprovados pelo predicado JS sobre as MESMAS linhas do banco. */
  async function idsAprovadosPeloJs() {
    // Colunas CRUAS de propósito: `data` chega como objeto Date (o driver entrega DATE
    // assim), e é justamente esse formato que o predicado precisa aguentar em produção
    // quando alguém o chamar de dentro de uma consulta pg em vez do PostgREST.
    const { rows } = await query(
      `SELECT cargas.id::text AS id, cargas.status, cargas.is_template,
              cargas.alloc_motorista, cargas.sheet_motorista, cargas.aspx_missing_since,
              cargas.data, cargas.horario, cargas.agenda_a_confirmar,
              cargas.viagem_id::text AS viagem_id, cargas.driver_visibility
         FROM public.cargas`,
    );
    const { rows: pacotes } = await query("SELECT id::text AS id, status FROM public.cargas_casadas");
    const pacoteStatusById = new Map(pacotes.map((p) => [p.id, p.status]));
    const { dateIso: todayIso, timeIso: nowTimeIso } = getSaoPauloWallClock();
    return new Set(
      rows.filter((c) => isOfferedToDriver(c, { todayIso, nowTimeIso, pacoteStatusById })).map((c) => c.id),
    );
  }

  const nomes = (ids) => [...ids].map((id) => nomePorId.get(id) ?? id).sort();

  it("o SQL do portal de fato exercita as fronteiras (fixture não é vácuo)", async () => {
    const sql = await idsAprovadosPeloSql();
    expect(nomes(sql)).toEqual([
      "aberta-simples",
      "agenda-a-confirmar-vencida",
      "alloc-vazio-vence-sheet",
      "hoje-depois-de-agora",
      "pacote-em-andamento",
      "pacote-publicado",
      "pacote-publicado-mas-privada",
    ]);
    // ...e reprova o resto (senão a paridade seria trivial de satisfazer).
    expect(nomePorId.size - sql.size).toBeGreaterThan(10);
  });

  it("o predicado JS NUNCA reprova o que o SQL aprova (nenhuma carga ofertada fica de fora)", async () => {
    const sql = await idsAprovadosPeloSql();
    const js = await idsAprovadosPeloJs();
    const perdidas = [...sql].filter((id) => !js.has(id));
    // Esta é a garantia que sustenta o portão: se o predicado reprovasse uma linha que o
    // portal oferta, o portão deixaria de protegê-la e a norma cairia em silêncio.
    expect(nomes(perdidas)).toEqual([]);
  });

  it("o excedente do JS é EXATAMENTE a divergência documentada — nada mais escapa", async () => {
    const sql = await idsAprovadosPeloSql();
    const js = await idsAprovadosPeloJs();
    const excedente = [...js].filter((id) => !sql.has(id));
    // `viagem_id` apontando para pacote inexistente: o SQL reprova (LEFT JOIN → NULL IN),
    // o JS aprova porque "pacote desconhecido" é desconhecido, e desconhecido não bloqueia.
    // Qualquer OUTRA divergência — regra nova no portal, cláusula esquecida aqui — cai
    // nesta lista e quebra o teste.
    expect(nomes(excedente)).toEqual(["pacote-inexistente"]);
    expect(excedente).toEqual([idDanglingPacote]);
  });

  it("com o pacote conhecido, JS e SQL são idênticos", async () => {
    // Tirando a única divergência documentada, os dois conjuntos batem linha a linha.
    const sql = await idsAprovadosPeloSql();
    const js = await idsAprovadosPeloJs();
    js.delete(idDanglingPacote);
    expect(nomes(js)).toEqual(nomes(sql));
  });
});

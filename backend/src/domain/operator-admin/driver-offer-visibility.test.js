import { describe, expect, it } from "vitest";

import { isOfferedToDriver, PACOTE_STATUS_OFERTADO } from "./driver-offer-visibility.js";

// Este predicado é a metade declarativa da norma "carga ofertada ao motorista NUNCA
// pode estar invisível ao operador". Aqui ficam as fronteiras cláusula a cláusula; a
// prova de que ele não DIVERGIU do SQL do portal está no teste de paridade
// (application/operator-admin/use-cases/driver-offer-visibility.parity.test.js), que
// roda o `buildDriverLoadFilters` de verdade contra o pg-mem.

const AGORA = { todayIso: "2026-08-06", nowTimeIso: "12:00:00" };

/** Carga OFERTADA por completo — todas as colunas presentes e explícitas. Cada teste
 *  sobrescreve UMA coluna, para a fronteira ficar isolada. */
const ofertada = (over = {}) => ({
  id: "c1",
  status: "OPEN",
  is_template: false,
  alloc_motorista: null,
  sheet_motorista: null,
  aspx_missing_since: null,
  data: "2026-08-10",
  horario: "08:00:00",
  agenda_a_confirmar: false,
  viagem_id: null,
  driver_visibility: "PUBLIC",
  ...over,
});

const oferta = (over, ctx = AGORA) => isOfferedToDriver(ofertada(over), ctx);

describe("isOfferedToDriver — as sete cláusulas do portal", () => {
  it("a carga base (OPEN, pública, sem motorista, futura, avulsa) é ofertada", () => {
    expect(oferta({})).toBe(true);
  });

  it("ciclo de vida: só OPEN é oferta", () => {
    for (const status of ["DRAFT", "BOOKED", "RESERVED", "CANCELLED", "EXPIRED"]) {
      expect(oferta({ status })).toBe(false);
    }
    expect(oferta({ status: "OPEN" })).toBe(true);
  });

  it("template nunca é oferta", () => {
    expect(oferta({ is_template: true })).toBe(false);
    expect(oferta({ is_template: false })).toBe(true);
  });

  it("alocação efetiva = COALESCE(alloc_motorista, sheet_motorista, ''): o override vence a planilha", () => {
    expect(oferta({ alloc_motorista: "ANA" })).toBe(false);
    expect(oferta({ sheet_motorista: "JOÃO" })).toBe(false);
    // alloc_motorista = '' é vazio EXPLÍCITO: o COALESCE para nele e a planilha nem é
    // consultada — carga que o operador desalocou no Monitor volta a ser oferta.
    expect(oferta({ alloc_motorista: "", sheet_motorista: "JOÃO" })).toBe(true);
  });

  it("motorista em BRANCOS bloqueia — no Postgres '   ' <> '', e trim divergiria do portal", () => {
    expect(oferta({ alloc_motorista: "   " })).toBe(false);
  });

  it("viagem fora do ASPX não é oferta (a viagem não existe mais na Shopee)", () => {
    expect(oferta({ aspx_missing_since: "2026-08-01T10:00:00Z" })).toBe(false);
    expect(oferta({ aspx_missing_since: null })).toBe(true);
  });

  it("janela de carregamento no relógio de São Paulo: passado sai, hoje-antes sai, hoje-depois e futuro ficam", () => {
    expect(oferta({ data: "2026-08-05" })).toBe(false);                          // ontem
    expect(oferta({ data: "2026-08-06", horario: "11:59:59" })).toBe(false);     // hoje, vencida
    expect(oferta({ data: "2026-08-06", horario: "12:00:00" })).toBe(true);      // hoje, no minuto
    expect(oferta({ data: "2026-08-06", horario: "12:00:01" })).toBe(true);      // hoje, à frente
    expect(oferta({ data: "2026-08-07", horario: "00:00:00" })).toBe(true);      // amanhã
  });

  it("horário no formato curto ('08:00') não vira carga vencida por comparação lexicográfica", () => {
    // '12:00' < '12:00:00' em comparação de string: sem normalizar, a carga marcada
    // para exatamente agora sumiria — esconder frete vivo é a direção proibida.
    expect(oferta({ data: "2026-08-06", horario: "12:00" })).toBe(true);
  });

  it("data nula = ainda em cadastro: fica ofertada (mesma escolha do portal)", () => {
    expect(oferta({ data: null })).toBe(true);
    expect(oferta({ data: "2026-08-05", horario: null })).toBe(false); // dia anterior some mesmo sem hora
    expect(oferta({ data: "2026-08-06", horario: null })).toBe(true);  // hoje sem hora fica o dia todo
  });

  it("agenda 'A confirmar' tira a carga do corte por completo (data/horário são placeholder)", () => {
    expect(oferta({ data: "2026-01-01", horario: "00:00:00", agenda_a_confirmar: true })).toBe(true);
    expect(oferta({ data: "2026-01-01", horario: "00:00:00", agenda_a_confirmar: false })).toBe(false);
  });

  it("carga avulsa: driver_visibility governa", () => {
    expect(oferta({ viagem_id: null, driver_visibility: "PRIVATE" })).toBe(false);
    expect(oferta({ viagem_id: null, driver_visibility: "PUBLIC" })).toBe(true);
  });

  it("perna de pacote: quem governa é o status do pacote, e driver_visibility é ignorado", () => {
    const ctx = { ...AGORA, pacoteStatusById: { p1: "rascunho", p2: "publicado", p3: "em_andamento", p4: "reservado" } };
    expect(isOfferedToDriver(ofertada({ viagem_id: "p1" }), ctx)).toBe(false);
    for (const id of ["p2", "p3", "p4"]) {
      expect(isOfferedToDriver(ofertada({ viagem_id: id }), ctx)).toBe(true);
    }
    // PREMIUM dentro de pacote publicado: o motorista vê, então o operador tem de ver.
    expect(isOfferedToDriver(ofertada({ viagem_id: "p2", driver_visibility: "PRIVATE" }), ctx)).toBe(true);
    expect(PACOTE_STATUS_OFERTADO).toEqual(["publicado", "reservado", "em_andamento"]);
  });

  it("aceita o mapa de pacotes como Map além de objeto", () => {
    const ctx = { ...AGORA, pacoteStatusById: new Map([["p1", "publicado"], ["p2", "rascunho"]]) };
    expect(isOfferedToDriver(ofertada({ viagem_id: "p1" }), ctx)).toBe(true);
    expect(isOfferedToDriver(ofertada({ viagem_id: "p2" }), ctx)).toBe(false);
  });
});

// A decisão de projeto que governa o arquivo: só um valor PRESENTE e explícito pode
// reprovar. Coluna fora do SELECT, migration não aplicada, data ilegível ou pacote fora
// do mapa resultam em "ofertada" — e o portão então protege a linha. Errar exibindo
// custa uma linha a mais; errar escondendo custou 24 cargas de frete vivo invisíveis.
describe("isOfferedToDriver — desconhecido NUNCA bloqueia", () => {
  it("coluna ausente do objeto não reprova nenhuma cláusula", () => {
    const colunas = [
      "status", "is_template", "alloc_motorista", "sheet_motorista",
      "aspx_missing_since", "data", "horario", "agenda_a_confirmar",
      "viagem_id", "driver_visibility",
    ];
    for (const coluna of colunas) {
      const carga = ofertada({});
      delete carga[coluna];
      expect(isOfferedToDriver(carga, AGORA), `coluna ausente: ${coluna}`).toBe(true);
    }
  });

  it("a carga MAIS desconhecida possível (só o id) é ofertada", () => {
    expect(isOfferedToDriver({ id: "c1" }, AGORA)).toBe(true);
  });

  // O caso que motiva tratar `undefined` diferente de `false`: a cadeia de fallbacks do
  // read model pode tirar `agenda_a_confirmar` do SELECT por um 42703 atribuído POR
  // ORDEM, sem o banco ter perdido a coluna. O portal segue aplicando a exceção; se o
  // portão lesse a ausência como `false`, reprovaria exatamente as cargas "A confirmar"
  // que ele existe para proteger.
  it("agenda_a_confirmar AUSENTE tira a carga do corte; `false` explícito mantém o corte", () => {
    const vencida = { id: "c1", status: "OPEN", data: "2026-01-01", horario: "00:00:00", viagem_id: null };
    expect(isOfferedToDriver(vencida, AGORA)).toBe(true);
    expect(isOfferedToDriver({ ...vencida, agenda_a_confirmar: false }, AGORA)).toBe(false);
  });

  it("data ilegível não reprova (dado duvidoso nunca esconde linha)", () => {
    expect(oferta({ data: "ontem de manhã" })).toBe(true);
    expect(oferta({ data: "2026-08-05", horario: "às oito" })).toBe(false); // o DIA anterior ainda decide
    expect(oferta({ data: "2026-08-06", horario: "às oito" })).toBe(true);  // hora ilegível hoje → fica
  });

  it("sem relógio, a janela de carregamento não é avaliada", () => {
    expect(isOfferedToDriver(ofertada({ data: "2020-01-01", horario: "00:00:00" }), {})).toBe(true);
  });

  it("perna de pacote sem mapa, ou com viagem_id fora do mapa, é tratada como ofertada", () => {
    // Divergência ASSUMIDA contra o SQL (LEFT JOIN reprova por NULL IN (...)): o read
    // model do Monitor não lê `cargas_casadas`, e inventar "não ofertada" a partir de um
    // dado que não fomos buscar é o erro que originou a norma.
    expect(oferta({ viagem_id: "p9" })).toBe(true);
    expect(isOfferedToDriver(ofertada({ viagem_id: "p9" }), { ...AGORA, pacoteStatusById: { p1: "rascunho" } })).toBe(true);
  });

  it("data como objeto Date (driver pg) é lida, não vira lixo", () => {
    expect(isOfferedToDriver(ofertada({ data: new Date("2026-08-10T00:00:00Z") }), AGORA)).toBe(true);
    expect(isOfferedToDriver(ofertada({ data: new Date("2026-08-01T00:00:00Z") }), AGORA)).toBe(false);
    expect(isOfferedToDriver(ofertada({ data: new Date("nada") }), AGORA)).toBe(true);
  });

  it("caixa de status/visibilidade é normalizada — divergência deliberada e sempre permissiva", () => {
    expect(oferta({ status: "open" })).toBe(true);
    expect(oferta({ driver_visibility: "public" })).toBe(true);
  });

  it("entrada que não é objeto não é oferta (não há linha para proteger)", () => {
    expect(isOfferedToDriver(null, AGORA)).toBe(false);
    expect(isOfferedToDriver(undefined, AGORA)).toBe(false);
  });
});

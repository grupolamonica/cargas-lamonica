// Conflito de alocação: o motorista (ou a placa) que o operador está colocando nesta
// carga JÁ está em OUTRA carga com a mesma data de carregamento.
//
// POR QUE EXISTE (incidente 2026-08-05): `LT0Q8502CP7S1` (sai 14:30) e `LT0Q8502CP7W1`
// (sai 15:30), mesma rota Simões Filho/BA → Jaboatão/PE, terminaram as duas com
// "Joao Soares de Jesus" e o MESMO cavalo GGY0E48 — fisicamente impossível. Duas
// operadoras trabalhavam a mesma fila: uma remanejando por arrasto, outra editando
// direto no modal com a tela já desatualizada. O sistema aceitou calado: não havia (e
// não há em nenhum caminho de alocação) qualquer verificação de duplicidade. As únicas
// menções a "duplo-booking" no código tratam de OUTRO assunto (reabrir carga para o
// portal do motorista).
//
// AVISA, NÃO BLOQUEIA (decisão do usuário): a mesma pessoa/veículo em duas cargas do
// mesmo dia pode ser legítima (rota curta, ida e volta), então o operador confirma. Quem
// decide é ele; o sistema só para de deixar passar em silêncio.
//
// Casamento de nome: reusa `driverNamesMatch` (sheet-monitor-enrichment.js), que é
// deliberadamente CONSERVADOR contra falso-positivo — o mesmo helper que já protege o
// selo do Monitor de casar homônimo. Placa é comparação exata (normalizada), então o
// risco de falso-positivo nela é baixo.
//
// Gate `DUPLICATE_ALLOC_WARN` = "off" desliga sem precisar de rollback (kill-switch no
// mesmo espírito de TWIN_MERGE / ASPX_STATUS_LAUNCHED). Default LIGADO.

import { driverNamesMatch } from "../sheet-monitor-enrichment.js";

// Cancelamento no destino não é conflito: a carga não vai rodar.
const CANCEL_STATUS_RE = /cancel|devolv|no[\s-]*show/i;

/** Placa normalizada p/ comparação exata (sem espaço/hífen, maiúsculas). */
function normPlate(v) {
  return String(v ?? "").replace(/[\s-]/g, "").toUpperCase();
}

const trim = (v) => String(v ?? "").trim();

/** "off" desliga o aviso. Qualquer outro valor (inclusive ausente) = ligado. */
export function duplicateAllocWarnEnabled() {
  return String(process.env.DUPLICATE_ALLOC_WARN ?? "").trim().toLowerCase() !== "off";
}

/**
 * Cargas com a MESMA data de carregamento que já usam este motorista e/ou esta placa.
 *
 * Escopo deliberadamente estreito para não gerar ruído:
 *  - mesma `data` (dia de carregamento) — foi o caso do incidente, é o que o operador
 *    entende, e não exige inventar uma janela de duração de viagem que o sistema não
 *    conhece;
 *  - só cargas VIVAS (status não-terminal) e sem status operacional de cancelamento;
 *  - exclui a própria carga e QUALQUER carga do mesmo LH (a gêmea lançada e a canônica
 *    da planilha são a MESMA viagem — sem isso, editar uma carga acusaria conflito com
 *    a própria gêmea, que é o defeito mais óbvio que este detector poderia ter).
 *
 * @param {import("pg").PoolClient} client transação em curso
 * @param {{ cargoId: string, lh?: string|null, data: any, motorista?: string|null,
 *           cavalo?: string|null }} args
 * @returns {Promise<Array<{ cargoId: string, lh: string|null, data: string|null,
 *   horario: string|null, origem: string|null, destino: string|null,
 *   motorista: string|null, cavalo: string|null, conflitaMotorista: boolean,
 *   conflitaCavalo: boolean }>>}
 */
export async function findAllocationConflicts(client, { cargoId, lh = null, data, motorista, cavalo }) {
  const nome = trim(motorista);
  const placa = normPlate(cavalo);
  if (!nome && !placa) return [];
  if (data == null) return [];

  // `data` pode chegar como Date (pg devolve DATE como Date UTC-midnight) ou string
  // 'YYYY-MM-DD'. Normaliza para o texto de parede — comparar Date com DATE no SQL
  // funciona, mas o texto deixa o parâmetro explícito e evita surpresa de fuso.
  const dataIso = data instanceof Date ? data.toISOString().slice(0, 10) : String(data).slice(0, 10);
  const lhTrim = trim(lh);

  const { rows } = await client.query(
    `SELECT c.id,
            COALESCE(c.sheet_lh, c.lh_manual) AS lh,
            c.data, c.horario, c.origem, c.destino,
            COALESCE(c.alloc_motorista, c.sheet_motorista) AS motorista,
            COALESCE(c.alloc_cavalo, c.sheet_cavalo) AS cavalo,
            COALESCE(c.alloc_status, c.sheet_status) AS status_operacional
       FROM public.cargas c
      WHERE c.id <> $1
        AND COALESCE(c.is_template, false) = false
        AND c.status NOT IN ('EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED')
        AND c.data = $2
        AND ($3 = '' OR (COALESCE(c.sheet_lh, '') <> $3 AND COALESCE(c.lh_manual, '') <> $3))`,
    [cargoId, dataIso, lhTrim],
  );

  // Filtro fino em JS (não em SQL): TRIM de argumento e alguns casts não existem no
  // harness pg-mem dos testes — mesma limitação já documentada em
  // promote-launched-twins.js. O SQL corta pelo que é indexável (data, LH, status) e o
  // casamento de nome/placa acontece aqui, onde o helper conservador já vive.
  const conflitos = [];
  for (const r of rows) {
    if (CANCEL_STATUS_RE.test(trim(r.status_operacional))) continue;
    if (trim(r.motorista) === "" && trim(r.cavalo) === "") continue;
    const conflitaMotorista = Boolean(nome) && driverNamesMatch(nome, r.motorista);
    const conflitaCavalo = Boolean(placa) && placa === normPlate(r.cavalo);
    if (!conflitaMotorista && !conflitaCavalo) continue;
    conflitos.push({
      cargoId: r.id,
      lh: trim(r.lh) || null,
      data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : (r.data ?? null),
      horario: r.horario ? String(r.horario).slice(0, 5) : null,
      origem: r.origem ?? null,
      destino: r.destino ?? null,
      motorista: r.motorista ?? null,
      cavalo: r.cavalo ?? null,
      conflitaMotorista,
      conflitaCavalo,
    });
  }
  return conflitos;
}

/**
 * Frase pronta em português para o operador (a tela não monta texto técnico).
 * Ex.: 'Joao Soares de Jesus já está na carga LT0Q8502CP7S1, que sai 05/08 às 14:30.'
 */
export function describeConflicts(conflitos, { motorista, cavalo } = {}) {
  const partes = conflitos.slice(0, 3).map((c) => {
    const quem = c.conflitaMotorista ? trim(motorista) || "Este motorista" : `O veículo ${trim(cavalo)}`;
    const onde = c.lh ? `na carga ${c.lh}` : "em outra carga";
    const quando = c.data
      ? ` que sai ${c.data.slice(8, 10)}/${c.data.slice(5, 7)}${c.horario ? ` às ${c.horario}` : ""}`
      : "";
    return `${quem} já está ${onde}${quando}.`;
  });
  if (conflitos.length > 3) partes.push(`E mais ${conflitos.length - 3} carga(s).`);
  return partes.join(" ");
}

export const __TEST__ = { normPlate, CANCEL_STATUS_RE };

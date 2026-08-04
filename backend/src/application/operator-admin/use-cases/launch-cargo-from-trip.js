// backend/src/application/operator-admin/use-cases/launch-cargo-from-trip.js
//
// "Lançar carga" a partir de uma viagem SPX da tela Programação. Cria um registro
// em public.cargas identificado pelo LH da viagem, com o cliente Shopee resolvido
// pelo nome.
//
// O LH é gravado em lh_manual — NÃO em sheet_lh. sheet_lh é território do sync da
// planilha (id determinístico via createSheetLoadId + índice único parcial); uma
// carga do sistema com sheet_lh preenchido seria tratada como linha da planilha e
// colidiria com o upsert do sync (ver migration 20260625120001_add_lh_manual_to_cargas
// e google-sheet-loads.js). lh_manual é o campo canônico p/ LH de carga do sistema.
//
// Dedup best-effort: antes de inserir, checa se o LH já existe como carga (por
// sheet_lh OU lh_manual) e devolve a existente (alreadyExists). Não há índice único
// em lh_manual — o botão fica desabilitado enquanto pendente no front, então o caso
// comum (re-clique) é coberto; cliques concorrentes de operadores distintos podem,
// em tese, gerar 2 cargas (sem outage, sem violação de índice).
//
// A carga nasce OPEN/PUBLIC e já JÁ recebe valor/distância/duração/bônus do catálogo
// de rotas (route_metrics_cache) na criação — denormalizados NA carga p/ ela ser
// self-contained e ficar "ready" no portal. Isso é necessário porque o portal do
// motorista roda como `anon` e route_metrics_cache é operator-only por RLS: se a carga
// não trouxer as métricas, o portal não consegue lê-las e a carga fica "em preparação".
// Se a rota ainda não está cadastrada, nasce sem valor (fica "em preparação" até o
// operador cadastrar a rota — e um novo lançamento/self-heal preenche). Não seta
// sheet_synced_at (não é carga do sync online da planilha) — o lifecycle do sync não a toca.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import {
  findNestleClientId,
  nestleClientNameCandidates,
  findSheetClientId,
  fetchRouteCatalogMetricsByLoadId,
  normalizeClientName,
} from "./_shared.js";
import { writeAllocationsToSheet, buildSystemCargoShellRow } from "../../google-sheets/sheet-writeback.js";

/**
 * @param {{
 *   lh: string, origem: string, destino: string,
 *   data: string, horario?: string, nome?: string, perfil?: string,
 *   clienteNome?: string|null, accepted?: boolean,
 *   operatorId?: string|null, correlationId?: string, deps?: object
 * }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function launchCargoFromTrip({
  lh,
  origem,
  destino,
  data,
  horario,
  dataDescarga,
  horarioDescarga,
  perfil,
  clienteNome = null,
  // ACEITA (acceptance_status=1 no SPX, ou Nestlé na aba Aceito): só carga aceita é
  // "puxada" pra planilha no lançamento (linha-casca). Não-aceita é lançada no portal
  // normalmente, mas NÃO vai pra planilha (fica de fora até ser aceita — ver aceite).
  accepted = false,
  operatorId = null,
  correlationId,
  deps = {},
} = {}) {
  const run = deps.withPgClient || withPgClient;
  const writeSheet = deps.writeAllocationsToSheet || writeAllocationsToSheet;

  const lhTrim = String(lh || "").trim();
  if (!lhTrim) throw new ValidationError("LH da viagem é obrigatório para lançar a carga.");
  const origemTrim = String(origem || "").trim();
  const destinoTrim = String(destino || "").trim();
  if (origemTrim.length < 2 || destinoTrim.length < 2) {
    throw new ValidationError("Origem/destino da viagem ausentes — não é possível lançar a carga.");
  }

  // Agenda "A CONFIRMAR": sem data de carregamento válida o operador AINDA pode lançar
  // — a carga entra como "a confirmar" (flag agenda_a_confirmar + rótulo "A confirmar"),
  // com data placeholder (hoje BRT) + horário 00:00 (colunas data/horario são NOT NULL).
  // Fica fora do portal do motorista (placeholder no passado) até o operador confirmar a
  // agenda. `cargas.data`/`horario` são BRT (wall-clock).
  const hasData = Boolean(data) && /^\d{4}-\d{2}-\d{2}$/.test(String(data));
  const aConfirmar = !hasData;
  const dataValue = hasData ? String(data) : getSaoPauloWallClock().dateIso;
  const horarioValue =
    hasData && /^\d{2}:\d{2}/.test(String(horario || "")) ? String(horario).slice(0, 5) : "00:00";
  const perfilValue = String(perfil || "").trim() || "CARRETA";
  // Rótulo de agenda denormalizado (domain/cargo-schedule.js) — 'YYYY-MM-DDTHH:MM'; ou
  // "A confirmar" quando a agenda ainda não foi definida.
  const carregamentoLabel = aConfirmar ? "A confirmar" : `${dataValue}T${horarioValue}`;
  // Descarga (ETA destino da viagem) → sheet_data_descarga 'YYYY-MM-DDTHH:MM'. Ausente = null.
  const descargaValue =
    dataDescarga && /^\d{4}-\d{2}-\d{2}$/.test(String(dataDescarga))
      ? `${dataDescarga}T${/^\d{2}:\d{2}/.test(String(horarioDescarga || "")) ? String(horarioDescarga).slice(0, 5) : "00:00"}`
      : null;

  const result = await run(async (client) => {
    // Métricas da rota (valor/bônus/distância/duração) do catálogo — resolvidas
    // server-side (bypassa a RLS operator-only de route_metrics_cache) e persistidas
    // NA carga p/ o portal (anon) conseguir lê-las. Sem rota cadastrada → tudo null
    // (carga fica "em preparação" até a rota existir + um novo lançamento).
    const routeMetrics =
      (
        await fetchRouteCatalogMetricsByLoadId(client, [
          { id: lhTrim, origem: origemTrim, destino: destinoTrim, perfil: perfilValue },
        ])
      ).get(lhTrim) || null;
    const valorValue = routeMetrics?.valor_padrao ?? null;
    const bonusValue = routeMetrics?.bonus_padrao ?? null;
    const distanciaValue = routeMetrics?.distancia_km ?? null;
    const duracaoValue = routeMetrics?.duracao_horas ?? null;

    // Cliente/fonte da carga: Nestlé (Projeto Galileu) → cliente "Nestle"; senão Shopee.
    // Detecção: hint clienteNome OU o lh casa uma oferta em nestle_ofertas. Resolvido
    // ANTES do dedup p/ o write-back da linha-casca rotear a fonte certa (shopee vs
    // nestle) tanto no caminho novo quanto no já-existente.
    // Detecção pelo NOME também não pode depender de um literal: compara sem
    // acento/caixa contra os nomes conhecidos do cliente Nestlé (env do sync +
    // históricos). Se o operador renomear o cliente, a detecção acompanha.
    const nomesNestle = new Set(nestleClientNameCandidates().map((n) => normalizeClientName(n)));
    let isNestle = clienteNome ? nomesNestle.has(normalizeClientName(String(clienteNome))) : false;
    if (!isNestle) {
      try {
        const { rows: nst } = await client.query(
          "SELECT 1 FROM public.nestle_ofertas WHERE grupos_id = $1 OR codembarque = $1 OR codprogcoleta = $1 LIMIT 1",
          [lhTrim],
        );
        isNestle = nst.length > 0;
      } catch (err) {
        if (err?.code !== "42P01") throw err; // tabela ausente → trata como não-Nestlé
      }
    }
    const source = isNestle ? "nestle" : "shopee";

    // Dedup: o LH pode já existir como carga da planilha (sheet_lh, sync online) OU
    // como carga já lançada aqui (lh_manual). Em ambos os casos devolve a existente.
    const existing = await client.query(
      "SELECT id, status, sheet_lh, lh_manual, origem, destino FROM public.cargas WHERE sheet_lh = $1 OR lh_manual = $1 LIMIT 1",
      [lhTrim],
    );
    if (existing.rows[0]) {
      const ex = existing.rows[0];
      // Self-heal: se é a NOSSA carga lançada (lh_manual, sem sheet_lh) e a origem/
      // destino divergem do atual (ex.: lançada antes com o rótulo "· TIPO", que não
      // casa com o catálogo de rotas), corrige p/ Cidade/UF limpo — assim a carga
      // volta a casar a rota (valor/métrica) e a aparecer no portal. NUNCA mexe em
      // carga da planilha (sheet_lh preenchido).
      let updated = false;
      if (ex.lh_manual === lhTrim && ex.sheet_lh == null) {
        // Sincroniza a NOSSA carga lançada com os dados atuais da viagem
        // (idempotente): origem/destino limpos (casam a rota), agenda e descarga.
        // Quando ainda é "a confirmar" (sem data no offer), NÃO sobrescreve a agenda —
        // o operador pode já ter confirmado a carga manualmente. Só sincroniza a agenda
        // quando há data real; nesse caso limpa a flag.
        //
        // `data`/`horario` entram JUNTO com o rótulo. Antes só o rótulo denormalizado
        // (`sheet_data_carregamento`) era atualizado e as colunas canônicas ficavam no
        // valor do primeiro lançamento — inclusive no placeholder hoje/00:00 de uma
        // carga que nasceu "a confirmar". As duas coisas divergiam de forma silenciosa
        // e cara: o rótulo (que as telas PREFEREM exibir) mostrava o horário certo
        // enquanto `data`/`horario` — que governam o portal do motorista, a expiração e
        // a ordenação do Monitor — apontavam para o passado, tirando a carga do portal
        // no mesmo movimento em que `agenda_a_confirmar` virava false (a flag era a
        // única coisa que mantinha o placeholder visível).
        await client.query(
          `UPDATE public.cargas
              SET origem = $1, destino = $2,
                  valor = COALESCE(valor, $7),
                  bonus = COALESCE(bonus, $8),
                  distancia_km = COALESCE(distancia_km, $9),
                  duracao_horas = COALESCE(duracao_horas, $10),
                  data = CASE WHEN $6::boolean THEN data ELSE $11::date END,
                  horario = CASE WHEN $6::boolean THEN horario ELSE $12::time END,
                  sheet_data_carregamento = CASE WHEN $6::boolean THEN sheet_data_carregamento ELSE $3 END,
                  sheet_data_descarga = COALESCE($4, sheet_data_descarga),
                  agenda_a_confirmar = CASE WHEN $6::boolean THEN agenda_a_confirmar ELSE false END,
                  updated_at = now()
            WHERE id = $5`,
          [origemTrim, destinoTrim, carregamentoLabel, descargaValue, ex.id, aConfirmar, valorValue, bonusValue, distanciaValue, duracaoValue, dataValue, horarioValue],
        );
        updated = true;
      }
      return {
        statusCode: 200,
        payload: {
          ok: true,
          alreadyExists: true,
          updated,
          id: ex.id,
          cargo: { id: ex.id, status: ex.status },
          meta: { correlationId },
        },
        // Linha-casca só p/ a NOSSA carga do sistema (lh_manual, sem sheet_lh) — nunca
        // p/ carga da planilha (o sync já a mantém). Fira o write-back mesmo no
        // já-existente: cobre o caso "lançou não-aceito, agora relançou aceito".
        _source: source,
        _writeShell: ex.lh_manual === lhTrim && ex.sheet_lh == null,
      };
    }

    // NUNCA resolver o cliente Nestlé por nome cravado: o operador renomeia o
    // cliente na tela (em 30/07 "Nestlé" virou "Produtos Alimentícios") e o
    // lançamento passou a falhar em 100% das ofertas Nestlé por 2 dias, sem
    // diagnóstico. findNestleClientId tenta o nome do chamador, o env que o sync
    // usa e os nomes históricos, comparando sem acento/caixa.
    const clienteId = isNestle
      ? await findNestleClientId(client, clienteNome)
      : await findSheetClientId(client);
    if (!clienteId) {
      throw new ValidationError(
        isNestle
          ? `Cliente Nestlé não encontrado (tentados: ${nestleClientNameCandidates().join(", ")}) — confira o nome do cliente na tela de Clientes ou o env GOOGLE_SHEET_NESTLE_CLIENT_NAME.`
          : "Cliente Shopee não encontrado — cadastre o cliente antes de lançar cargas SPX.",
      );
    }

    // `sheet_source` = fonte da viagem lançada. O INSERT não gravava a coluna, então
    // TODA carga lançada ficava com sheet_source NULL e o write-back roteava por
    // normSource(null) === 'shopee': puxar reserva / reverter numa carga NESTLÉ
    // lançada fazia POST na planilha da SHOPEE, que pode ter linha com o mesmo LH
    // (há LH repetido entre as duas em produção) e teria motorista/placas
    // sobrescritos. Gravando a fonte, o write-back de uma fonte sem URL configurada
    // (Nestlé) vira no-op — o comportamento desejado — e a Shopee segue igual.
    const { rows } = await client.query(
      `INSERT INTO public.cargas
         (cliente_id, data, horario, origem, destino, perfil, status, is_template,
          driver_visibility, lh_manual, sheet_data_carregamento, sheet_data_descarga,
          agenda_a_confirmar, created_by, valor, bonus, distancia_km, duracao_horas, sheet_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', false, 'PUBLIC', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [clienteId, dataValue, horarioValue, origemTrim, destinoTrim, perfilValue, lhTrim, carregamentoLabel, descargaValue, aConfirmar, operatorId, valorValue, bonusValue, distanciaValue, duracaoValue, source ?? null],
    );

    return {
      statusCode: 201,
      payload: {
        ok: true,
        alreadyExists: false,
        aConfirmar,
        id: rows[0].id,
        cargo: { id: rows[0].id, status: "OPEN" },
        clienteId,
        meta: { correlationId },
      },
      _source: source,
      _writeShell: true,
    };
  });

  // Linha-casca na planilha — só p/ carga do SISTEMA (lh_manual) e só quando a viagem
  // está ACEITA (acceptance_status=1 / Nestlé aba Aceito). `createOnly` cria a linha se
  // o LH não existir e NÃO toca a existente (não apaga motorista já preenchido pelo
  // Monitor). Best-effort, fora do fluxo principal: carga da planilha (sheet_lh) e
  // carga não-aceita não escrevem aqui.
  if (accepted && result._writeShell) {
    void writeSheet([
      buildSystemCargoShellRow({
        lh: lhTrim,
        source: result._source,
        origem: origemTrim,
        destino: destinoTrim,
        carregamentoLabel,
        descargaLabel: descargaValue,
      }),
    ]).catch(() => {});
  }

  return { statusCode: result.statusCode, payload: result.payload };
}

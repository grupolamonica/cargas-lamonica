// Solta, NA LEITURA do Monitor, o `alloc_status` que ficou para trás da planilha.
//
// Por que na leitura (e não só no saneamento): o override do operador mora em
// `cargas.alloc_status`, mas quem podia soltá-lo — o sync ASPX
// (`reconcile-aspx-status`) e o saneamento (`releaseFrozenAllocStatus`) — ancora a
// decisão em `cargas.sheet_status`. Numa viagem LANÇADA na Programação
// (`lh_manual`, `sheet_lh` NULL) esse espelho é sempre NULL: o sync casa por
// `sheet_lh` e nunca a visita, e o saneamento a exclui pelo próprio filtro
// (`COALESCE(sheet_status,'') <> ''`). O override dessa carga, portanto, NUNCA é
// reavaliado — e ele continua sendo aplicado à linha da planilha do MESMO LH
// (o overlay `allocByLh` é keyed por `lh_manual` também, para a edição da lançada
// aparecer na linha exibida). Resultado medido em produção: 45 viagens exibindo
// status errado, 18 delas com override VAZIO ("").
//
// O caso vazio é o pior: `""` mascara o status da planilha (COALESCE devolve "",
// não cai para a planilha), o status efetivo fica vazio e o overlay AO VIVO do SPX
// então preenche a linha com o status do portal — uma viagem com `CTE ENVIADO` na
// planilha voltava a aparecer como `CARREGADO`. Do ponto de vista do operador, o
// status "volta sozinho" para o do SPX.
//
// A decisão é a MESMA do sync/saneamento (`shouldReleaseAllocStatusOverride`, no
// domínio): solta só quando a planilha está À FRENTE no pipeline, ou quando o
// override é o "" artefato de uma carga COM motorista. Overrides deliberados —
// `CTE EM EMISSÃO`, `CTE ENVIADO`, `NO SHOW`, `CANCELADO`, e o "" de "Disponível"
// em carga sem motorista — continuam valendo. A diferença é só a FONTE do "valor
// da planilha": aqui é a linha do SNAPSHOT (o que o operador está vendo), não o
// espelho `cargas.sheet_status`.
//
// Não escreve nada: devolve um `allocByLh` novo com o override solto (→ null) nas
// chaves afetadas. Como esse mapa também vai na resposta, o cliente
// (`mergeAllocIntoRow`) enxerga exatamente a mesma decisão.

import { shouldReleaseAllocStatusOverride } from "../../../domain/operator-admin/aspx-status-rules.js";

/** Motorista EFETIVO = override do operador ?? planilha — `??` (COALESCE), igual ao
 *  saneamento (`releaseFrozenAllocStatus`) e ao que a linha EXIBE (mergeAllocIntoRow):
 *  um override "" é vazio EXPLÍCITO e vence a planilha (linha sem motorista). Usar
 *  `||` aqui divergiria da regra que decide, logo abaixo, se o "" de status é
 *  artefato (carga com motorista) ou "Disponível" deliberado. */
function effectiveDriver(row, alloc) {
  const v = alloc && alloc.alloc_motorista != null ? alloc.alloc_motorista : row?.motoristas;
  return String(v ?? "").trim();
}

/**
 * @param {{ baseRows?: Array<object>, allocByLh?: Record<string, any> }} args
 *   baseRows   = linhas CRUAS do snapshot da planilha (antes de qualquer overlay);
 *                é o `status` delas que serve de referência.
 *   allocByLh  = overlay de alocação por LH (planilha + lançadas), como lido do banco.
 * @returns {{ allocByLh: Record<string, any>, released: Array<{ lh: string, de: string, para: string }> }}
 */
export function releaseStaleAllocStatusOverrides({ baseRows = [], allocByLh = {} } = {}) {
  const released = [];
  let next = null; // clonado só se houver algo a soltar (leitura quente do Monitor)

  for (const row of baseRows) {
    const lh = String(row?.lh ?? "").trim();
    if (!lh) continue;
    const alloc = allocByLh[lh];
    // Sem override (ou já sem status) → nada a decidir.
    if (!alloc || alloc.alloc_status == null) continue;
    const sheetStatus = String(row?.status ?? "").trim();
    if (!sheetStatus) continue;
    if (
      !shouldReleaseAllocStatusOverride(alloc.alloc_status, sheetStatus, {
        hasDriver: effectiveDriver(row, alloc) !== "",
      })
    ) {
      continue;
    }
    if (!next) next = { ...allocByLh };
    next[lh] = { ...alloc, alloc_status: null };
    released.push({
      lh,
      de: String(alloc.alloc_status).trim() === "" ? "(vazio)" : String(alloc.alloc_status),
      para: sheetStatus,
    });
  }

  return { allocByLh: next ?? allocByLh, released };
}

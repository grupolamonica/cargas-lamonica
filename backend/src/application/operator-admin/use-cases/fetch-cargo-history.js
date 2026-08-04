import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { resolveOperatorDirectory } from "./audit-logs-read-model.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

// ── Helpers de apresentação (linguagem do operador, sem jargão técnico) ──────

/**
 * Nome do Angellira do lead, JÁ EXTRAÍDO NO SERVIDOR pela projeção
 * `validation_summary_json->'driver'->'angelira'->>'displayName'` (ver a query dos
 * eventos abaixo). Recebe o texto, não o JSON.
 *
 * EGRESS: antes o SELECT trazia o `validation_summary_json` INTEIRO só p/ ler este
 * único campo em JS. É a coluna mais larga do banco (~1,5 KB/linha) e o LEFT JOIN a
 * repete em CADA evento do lead (o modal lê até 200 eventos) — o mesmo JSON descia
 * 5-6x por lead. A projeção é a MESMA expressão já usada no read do Monitor (mapa de
 * cargas RESERVADAS, interface/http/operator-admin/handlers.js).
 *
 * A checagem de tipo + trim ficam AQUI (não no SQL) p/ o resultado ser idêntico ao
 * anterior: `->>` devolve NULL quando a chave não existe ou é JSON null (→ ""), e o
 * `.trim()` do JS corta \t\n (o TRIM do SQL só corta espaço). Os produtores sempre
 * gravam `displayName` como string ou null (angellira-client), então não há caso de
 * escalar não-string em que `->>` divergiria do `typeof === "string"` antigo.
 */
function angelliraDisplayName(displayName) {
  return typeof displayName === "string" && displayName.trim() ? displayName.trim() : "";
}

function driverLabel({ name, phone }) {
  if (name) return name;
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 4) return `Motorista (final ${digits.slice(-4)})`;
  return "Motorista";
}

function vehicleLabel(cavalo, carreta) {
  const parts = [];
  if (cavalo && String(cavalo).trim()) parts.push(`cavalo ${String(cavalo).trim()}`);
  if (carreta && String(carreta).trim()) parts.push(`carreta ${String(carreta).trim()}`);
  return parts.join(" · ");
}

function withVehicle(base, cavalo, carreta) {
  const v = vehicleLabel(cavalo, carreta);
  return v ? `${base} — ${v}` : base;
}

// Nome de quem agiu, em linguagem clara. Operador → nome/e-mail do diretório;
// motorista pelo portal e ações automáticas do sistema recebem rótulos amigáveis.
function actorLabel({ actorType, actorId }, directory) {
  if (actorType === "operator") {
    const info = actorId ? directory.get(actorId) : null;
    return info?.displayName || info?.email || "Operador";
  }
  if (actorType === "driver" || actorType === "public") return "Motorista (pelo portal)";
  return "Sistema (automático)";
}

// Nome do operador que assinou um evento de auditoria (id → diretório).
function auditActorLabel(actorUserId, directory) {
  if (!actorUserId) return "Sistema (automático)";
  return directory.get(actorUserId)?.displayName || directory.get(actorUserId)?.email || "Operador";
}

/**
 * Rótulo em linguagem do operador de cada ação de carga registrada na auditoria.
 * A tela do Monitor não mostra código: tipo desconhecido cai num rótulo genérico
 * (aparece no histórico, mas sem jargão técnico).
 */
const AUDIT_TITLES = {
  "operator.cargo.allocation_updated": "Alocação alterada no sistema",
  "operator.cargo.allocation_reassigned": "Fila remanejada",
  "operator.cargo.allocation_reverted": "Alteração desfeita",
  "operator.cargo.allocation_pinned": "Carga fixada",
  "operator.cargo.allocation_unpinned": "Carga desafixada",
  "operator.cargo.monitor_system_updated": "Carga editada no Monitor",
  "operator.cargo.updated": "Carga editada",
  "operator.cargo.created": "Carga criada",
  "operator.cargo.duplicated": "Carga duplicada",
  "operator.cargo.imported": "Carga importada",
  "operator.cargo.deleted": "Carga excluída",
  "operator.cargo.cancel_cascade": "Carga cancelada (motorista desceu)",
  "operator.cargo.queue_descended": "Motorista desceu na fila",
  "operator.cargo.status_toggled": "Disponibilidade para o motorista alterada",
  "operator.cargo.rodopar_status_changed": "Check Rodopar alterado",
  "operator.cargo.reserva_created": "Reserva criada",
  "operator.cargo.reserva_updated": "Reserva editada",
  "operator.cargo.reserva_deleted": "Reserva removida",
  "operator.cargo.reserva_assigned": "Reserva atribuída à carga",
  "operator.cargo.aspx_assign": "Motorista atribuído no ASPX",
  "operator.cargo.aspx_accept": "Viagem aceita no ASPX",
  "system.cargo.twin_retired": "Carga duplicada aposentada",
  "system.cargo.sheet_status_mirror_reverted": "Status espelhado da planilha revertido",
};

// Campos do metadata que descrevem a ação em linguagem do operador. Lista fechada:
// o metadata bruto carrega chaves técnicas (e às vezes PII) que não vão pra tela.
const AUDIT_DETAIL_FIELDS = [
  ["motorista", "motorista"],
  ["status", "status"],
  ["motivo", "motivo"],
  ["descricao", "motivo"],
  ["reason", "motivo"],
  ["origem", "origem"],
  ["destino", "destino"],
  ["count", "cargas afetadas"],
];

const fmtValor = (v) => (v == null || String(v).trim() === "" ? "vazio" : String(v).trim());

/** Descrição da mudança: `changes` (antes→depois) quando houver; senão resumo curto. */
function auditDetalhe(metadata) {
  const changes = Array.isArray(metadata?.changes) ? metadata.changes : [];
  if (changes.length > 0) {
    return changes.map((ch) => `${ch.label || ch.field}: ${fmtValor(ch.before)} → ${fmtValor(ch.after)}`).join(" · ");
  }
  const partes = [];
  for (const [chave, rotulo] of AUDIT_DETAIL_FIELDS) {
    const valor = metadata?.[chave];
    if (valor == null || String(valor).trim() === "") continue;
    if (typeof valor === "object") continue;
    partes.push(`${rotulo}: ${String(valor).trim()}`);
    if (partes.length >= 3) break;
  }
  return partes.join(" · ") || null;
}

/**
 * Um evento de auditoria ancorado NESTA carga → item do histórico.
 * `allocation_updated` sem mudança real continua sendo ruído (pulado); os demais
 * tipos são ações discretas e sempre aparecem.
 */
function auditItem(row, directory) {
  const tipo = row.event_type;
  if (tipo === "operator.cargo.allocation_updated") {
    const changes = Array.isArray(row.metadata?.changes) ? row.metadata.changes : [];
    if (changes.length === 0) return null;
  }
  return {
    quando: row.created_at,
    titulo: AUDIT_TITLES[tipo] || "Alteração registrada na carga",
    detalhe: auditDetalhe(row.metadata),
    por: auditActorLabel(row.actor_user_id, directory),
    // `ALLOC_AUDIT` preservado p/ o marcador já existente no modal; os demais tipos
    // usam o próprio código (o front cai na cor padrão).
    tipo: tipo === "operator.cargo.allocation_updated" ? "ALLOC_AUDIT" : tipo,
  };
}

/**
 * Remanejamento/cascata e "desfazer" gravam UM evento para o lote todo. Extrai só o
 * trecho desta carga (por LH ou por id) — sem isso o item viria com a movimentação
 * de terceiros no detalhe.
 */
function cascadeItem(row, { lh, ids }, directory) {
  const md = row.metadata ?? {};
  const listas = [md.moves, md.beforeMoves, md.reverted].filter(Array.isArray);
  const idSet = new Set(ids);
  let alvo = null;
  for (const lista of listas) {
    alvo = lista.find((m) => (lh && String(m?.lh ?? "").trim() === lh) || (m?.cargoId && idSet.has(m.cargoId)));
    if (alvo) break;
  }
  if (!alvo) return null;
  const motorista = String(alvo.motorista ?? "").trim();
  const detalhe = motorista
    ? withVehicle(motorista, alvo.cavalo, alvo.carreta)
    : "Motorista removido desta carga";
  return {
    quando: row.created_at,
    titulo: AUDIT_TITLES[row.event_type] || "Alteração registrada na carga",
    detalhe,
    por: auditActorLabel(row.actor_user_id, directory),
    tipo: row.event_type,
  };
}

/**
 * Histórico de uma carga para o modal do Monitor, em linguagem do operador: o que
 * aconteceu em cada etapa, QUEM fez, QUEM foi alocado e os VEÍCULOS. Junta os
 * eventos do lead (fila, reserva, cancelamento, gravação na planilha), a alocação
 * atual feita no sistema e as ações do operador registradas na auditoria.
 *
 * IDENTIFICAÇÃO DA CARGA (era o buraco): um LH do Monitor pode viver em MAIS DE UMA
 * carga — a da planilha (`sheet_lh`, id determinístico) e/ou a do SISTEMA lançada na
 * Programação (`lh_manual`, id ALEATÓRIO, `sheet_lh` nulo) — e a carga do sistema pode
 * nem ter LH. Ler só `sheet_lh = lh` / `resource_id = createSheetLoadId(lh)` deixava
 * 297 cargas de produção com o histórico VAZIO ou pela metade, porque tudo estava
 * gravado na OUTRA carga do mesmo LH. Aqui a carga é resolvida como no caminho de
 * ESCRITA (ver `resolveMonitorCargoByLh`) e a leitura cobre TODAS as cargas do LH.
 *
 * Best-effort: qualquer falha devolve o que conseguiu (nunca quebra o modal).
 *
 * @param {{ lh?: string, cargoId?: string, correlationId?: string }} params
 *   `lh` (carga da planilha ou lançada) e/ou `cargoId` (carga do sistema, inclusive
 *   as SEM LH — que o front nem conseguia consultar antes). Pelo menos um.
 */
export async function fetchCargoHistoryByLh({ lh, cargoId, correlationId }) {
  return withPgClient(async (client) => {
    let eventRows = [];
    let allocRows = [];
    let auditRows = [];
    let cascadeRows = [];

    const lhTrim = String(lh ?? "").trim();
    const explicitCargoId = String(cargoId ?? "").trim();
    // Sem identificador nenhum não há o que buscar (o schema já exige um, mas o
    // caminho SQL abaixo é montado a partir deles — não pode ficar sem predicado).
    if (!lhTrim && !explicitCargoId) {
      return { statusCode: 200, payload: { items: [], meta: { correlationId } } };
    }
    // Id determinístico da carga da PLANILHA — âncora histórica dos audit logs e
    // fallback quando a carga ainda não existe no banco (linha só no snapshot).
    //
    // NAMESPACE: `createSheetLoadId(lh)` sem fonte = namespace da SHOPEE. É o mesmo
    // que esta leitura já usava; a carga Nestlé segue fora (limitação conhecida e
    // deliberada, igual à cascata). NÃO casar por `sheet_lh = <LH>`: `sheet_lh` é
    // único só POR FONTE e há LH vivo nas duas planilhas ao mesmo tempo — o ramo
    // traria o histórico da carga da OUTRA fonte para dentro desta. Mostrar o
    // histórico de outra carga é pior do que não mostrar nenhum.
    const sheetCargoId = lhTrim ? createSheetLoadId(lhTrim) : "";

    // Todas as cargas que representam este LH/carga: a da planilha (id determinístico
    // da fonte) + a do SISTEMA lançada na Programação (`lh_manual`, `sheet_lh` nulo) +
    // a carga pedida explicitamente. Gêmeas entram TODAS — a alocação viva pode estar
    // em qualquer uma delas.
    const anchorIds = new Set([sheetCargoId, explicitCargoId].filter(Boolean));
    try {
      const resolved = await client.query(
        `
          SELECT id FROM public.cargas
           WHERE id = $2 OR (lh_manual = $1 AND sheet_lh IS NULL)
           LIMIT 20
        `,
        [lhTrim, explicitCargoId || sheetCargoId || null],
      );
      for (const r of resolved.rows) anchorIds.add(r.id);
    } catch {
      /* sem resolução: seguem as âncoras determinísticas acima */
    }
    const ids = [...anchorIds];

    // Predicado "esta carga", reusado pelos SELECTs em cargas: a lançada (por
    // `lh_manual`) e os ids resolvidos. Parâmetros escalares (sem arrays) p/ rodar
    // igual no Postgres e no pg-mem dos testes.
    const idPlaceholders = ids.map((_, i) => `$${i + 2}`);
    const cargoMatch = [
      ...(lhTrim ? ["(c.lh_manual = $1 AND c.sheet_lh IS NULL)"] : []),
      ...idPlaceholders.map((p) => `c.id = ${p}`),
    ].join(" OR ");
    const cargoParams = [lhTrim, ...ids];

    try {
      const events = await client.query(
        `
          SELECT e.event_type, e.event_payload_json, e.actor_type, e.actor_id, e.created_at,
                 l.horse_plate, l.trailer_plate, l.phone,
                 l.validation_summary_json->'driver'->'angelira'->>'displayName' AS angellira_display_name
          FROM public.load_public_lead_events e
          JOIN public.cargas c ON c.id = e.load_id
          LEFT JOIN public.load_public_leads l ON l.id = e.lead_id
          WHERE ${cargoMatch}
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT 200
        `,
        cargoParams,
      );
      eventRows = events.rows;

      const allocs = await client.query(
        `
          SELECT c.id, c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta, c.alloc_descricao,
                 c.alloc_updated_by, c.alloc_updated_at
          FROM public.cargas c
          WHERE (${cargoMatch}) AND COALESCE(TRIM(c.alloc_motorista), '') <> ''
          ORDER BY c.alloc_updated_at DESC NULLS LAST, c.id ASC
          LIMIT 10
        `,
        cargoParams,
      );
      allocRows = allocs.rows;
    } catch {
      eventRows = [];
      allocRows = [];
    }

    // Best-effort SEPARADO: uma falha aqui (ex.: tabela ausente) NÃO pode zerar os
    // eventos/alocação já lidos acima.
    //
    // TODAS as ações de carga registradas na auditoria — não só `allocation_updated`.
    // Cancelar em cascata, editar a carga do sistema, ligar/desligar pro motorista,
    // descer na fila, fixar, duplicar: tudo isso é "o que aconteceu com a carga" e o
    // operador não via nada disso (1 de 15 tipos era exibido).
    try {
      const audit = await client.query(
        `
          SELECT event_type, actor_user_id, created_at, metadata
          FROM public.security_audit_logs
          WHERE resource_id = ANY($1)
            AND (event_type LIKE 'operator.cargo.%' OR event_type LIKE 'system.cargo.%')
          ORDER BY created_at ASC, id ASC
          LIMIT 200
        `,
        [ids],
      );
      auditRows = audit.rows;
    } catch {
      auditRows = [];
    }

    // Remanejamento/cascata e "desfazer" gravam UM evento para o lote inteiro, sem
    // resource_id — a carga vive dentro do metadata. Ancora por conteúdo (jsonb @>)
    // p/ a carga arrastada na fila também aparecer no seu próprio histórico.
    try {
      const needles = [];
      if (lhTrim) needles.push(JSON.stringify([{ lh: lhTrim }]));
      for (const id of ids) needles.push(JSON.stringify([{ cargoId: id }]));
      if (needles.length > 0) {
        const conds = needles
          .map((_, i) => `metadata->'moves' @> $${i + 1}::jsonb
                       OR metadata->'beforeMoves' @> $${i + 1}::jsonb
                       OR metadata->'reverted' @> $${i + 1}::jsonb`)
          .join(" OR ");
        const cascade = await client.query(
          `
            SELECT event_type, actor_user_id, created_at, metadata
            FROM public.security_audit_logs
            WHERE resource_id IS NULL
              AND event_type IN ('operator.cargo.allocation_reassigned', 'operator.cargo.allocation_reverted')
              AND (${conds})
            ORDER BY created_at ASC, id ASC
            LIMIT 200
          `,
          needles,
        );
        cascadeRows = cascade.rows;
      }
    } catch {
      cascadeRows = [];
    }

    // Diretório de operadores (id → nome). Best-effort — se indisponível, cai
    // no rótulo "Operador".
    let directory = new Map();
    try {
      directory = await resolveOperatorDirectory();
    } catch {
      directory = new Map();
    }

    const items = [];

    for (const row of eventRows) {
      const por = actorLabel({ actorType: row.actor_type, actorId: row.actor_id }, directory);
      const nome = driverLabel({ name: angelliraDisplayName(row.angellira_display_name), phone: row.phone });
      const payload = row.event_payload_json ?? {};

      let titulo = null;
      let detalhe = null;
      const tipo = row.event_type;

      switch (row.event_type) {
        case "PRE_REGISTERED":
          titulo = "Cadastro iniciado";
          detalhe = nome;
          break;
        case "QUEUED":
          titulo = "Entrou na fila de candidatos";
          detalhe = withVehicle(nome, row.horse_plate, row.trailer_plate);
          break;
        case "WHATSAPP_CLICKED":
          titulo = "Chamou no WhatsApp";
          detalhe = nome;
          break;
        case "APPROVED":
          titulo = "Reservado para o motorista";
          detalhe = withVehicle(nome, row.horse_plate, row.trailer_plate);
          break;
        case "CANCELLED":
          titulo = "Reserva/candidatura cancelada";
          detalhe = nome;
          break;
        case "SHEET_WRITEBACK": {
          titulo = "Gravado na planilha";
          const m = typeof payload.motorista === "string" && payload.motorista.trim() ? payload.motorista.trim() : nome;
          detalhe = withVehicle(m, payload.cavalo, payload.carreta);
          break;
        }
        default:
          titulo = row.event_type;
          detalhe = nome;
      }

      items.push({ quando: row.created_at, titulo, detalhe, por, tipo });
    }

    // Alocação atual feita no sistema (operador escolheu motorista/veículo). Com
    // carga GÊMEA (planilha + sistema no mesmo LH) as duas podem carregar a mesma
    // alocação — dedup pelo conteúdo p/ não duplicar a linha no modal.
    const allocSeen = new Set();
    for (const a of allocRows) {
      const chave = [a.alloc_motorista, a.alloc_cavalo, a.alloc_carreta, a.alloc_updated_at]
        .map((v) => String(v ?? "").trim())
        .join("|");
      if (allocSeen.has(chave)) continue;
      allocSeen.add(chave);
      const por = a.alloc_updated_by
        ? directory.get(a.alloc_updated_by)?.displayName || directory.get(a.alloc_updated_by)?.email || "Operador"
        : "Operador";
      let detalhe = withVehicle(String(a.alloc_motorista).trim(), a.alloc_cavalo, a.alloc_carreta);
      if (a.alloc_descricao && String(a.alloc_descricao).trim()) {
        detalhe += ` · motivo: ${String(a.alloc_descricao).trim()}`;
      }
      items.push({
        quando: a.alloc_updated_at,
        titulo: "Motorista alocado no sistema",
        detalhe,
        por,
        tipo: "ALLOC_OPERADOR",
      });
    }

    // Ações registradas na auditoria (operador e automáticas). `changes` (antes→depois)
    // quando existe; senão um resumo curto do que a ação carrega.
    for (const r of auditRows) {
      const item = auditItem(r, directory);
      if (item) items.push(item);
    }

    // Remanejamento/cascata: o evento é do LOTE — extrai só o trecho DESTA carga.
    for (const r of cascadeRows) {
      const item = cascadeItem(r, { lh: lhTrim, ids }, directory);
      if (item) items.push(item);
    }

    // Ordena cronologicamente (mais antigo → mais novo). Entradas sem data ao fim.
    items.sort((x, y) => {
      const tx = x.quando ? new Date(x.quando).getTime() : Number.POSITIVE_INFINITY;
      const ty = y.quando ? new Date(y.quando).getTime() : Number.POSITIVE_INFINITY;
      return tx - ty;
    });

    return {
      statusCode: 200,
      payload: { items, meta: { correlationId } },
    };
  });
}

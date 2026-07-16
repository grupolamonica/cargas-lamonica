/**
 * Taxonomia do log de auditoria (security_audit_logs) — FONTE DA VERDADE.
 *
 * Centraliza, num único lugar consumido por backend E frontend (via API):
 *   - o rótulo humano de cada event_type (pt-BR);
 *   - a categoria de negócio de cada event_type ("tipo de log").
 *
 * DC-185: o filtro multiselect da tela de Auditoria filtra por CATEGORIA.
 * Cada categoria agrupa um conjunto fixo de event_types (associação 1:1 —
 * um evento pertence a exatamente uma categoria) para que a tradução
 * categoria → WHERE event_type IN (...) seja determinística no read-model.
 *
 * "Valores" (mudança de valor/bônus) não é uma categoria própria: mudanças
 * de valor acontecem dentro de Cargas/Rotas e ficam explícitas pelo
 * antes → depois do DC-184 ({metadata.changes}).
 */

// Ordem = ordem de exibição no multiselect.
export const AUDIT_LOG_CATEGORIES = [
  { key: "cargas", label: "Cargas" },
  { key: "alocacao", label: "Alocação (Monitor)" },
  { key: "reservas", label: "Reservas" },
  { key: "rotas", label: "Rotas" },
  { key: "clientes", label: "Clientes (embarcadores)" },
  { key: "cadastros", label: "Cadastros / Motoristas" },
  { key: "pacotes", label: "Cargas casadas (pacotes)" },
  { key: "seguranca", label: "Segurança / Acessos" },
  { key: "sistema", label: "Sistema" },
];

const CATEGORY_LABELS = new Map(AUDIT_LOG_CATEGORIES.map((c) => [c.key, c.label]));

const FALLBACK_CATEGORY = { key: "outros", label: "Outros" };

/**
 * Catálogo: event_type → { label, category }.
 * Todo event_type gravado por insertSecurityAuditEvent deve estar aqui.
 * Ao criar um novo evento auditado, ADICIONE-O a este mapa (senão cai em
 * "Outros" na exibição e fica invisível ao filtro por categoria).
 */
export const AUDIT_EVENT_CATALOG = {
  // ── Cargas ──────────────────────────────────────────────────────────────
  "operator.cargo.created": { label: "Carga cadastrada", category: "cargas" },
  "operator.cargo.updated": { label: "Carga atualizada", category: "cargas" },
  "operator.cargo.monitor_system_updated": { label: "Carga editada no Monitor", category: "cargas" },
  "operator.cargo.duplicated": { label: "Carga duplicada", category: "cargas" },
  "operator.cargo.status_toggled": { label: "Carga: status alterado", category: "cargas" },
  "operator.cargo.deleted": { label: "Carga excluída", category: "cargas" },
  "operator.cargo.imported": { label: "Cargas importadas", category: "cargas" },
  "operator.cargo.cancel_cascade": { label: "Carga cancelada (cascata)", category: "cargas" },

  // ── Alocação (Monitor) ────────────────────────────────────────────────────
  "operator.cargo.allocation_updated": { label: "Alocação atualizada", category: "alocacao" },
  "operator.cargo.allocation_reassigned": { label: "Alocação realocada (arrasto)", category: "alocacao" },
  "operator.cargo.queue_descended": { label: "Fila descida (cascata)", category: "alocacao" },
  "operator.cargo.aspx_accept": { label: "Viagem SPX aceita", category: "alocacao" },
  "operator.cargo.aspx_assign": { label: "Viagem SPX lançada", category: "alocacao" },

  // ── Reservas ──────────────────────────────────────────────────────────────
  "operator.cargo.reserva_assigned": { label: "Reserva atribuída à carga", category: "reservas" },

  // ── Rotas ─────────────────────────────────────────────────────────────────
  "operator.route.saved": { label: "Rota salva", category: "rotas" },
  "operator.route.updated": { label: "Rota atualizada", category: "rotas" },
  "operator.rota_cliente.attached": { label: "Rota vinculada a cliente", category: "rotas" },
  "operator.rota_cliente.detached": { label: "Rota desvinculada de cliente", category: "rotas" },

  // ── Clientes (embarcadores) ────────────────────────────────────────────────
  "operator.cliente.created": { label: "Cliente cadastrado", category: "clientes" },
  "operator.cliente.updated": { label: "Cliente atualizado", category: "clientes" },
  "operator.cliente.deleted": { label: "Cliente excluído", category: "clientes" },

  // ── Cadastros / Motoristas ─────────────────────────────────────────────────
  "operator.cadastro.approved": { label: "Cadastro aprovado", category: "cadastros" },
  "operator.cadastro.rejected": { label: "Cadastro rejeitado", category: "cadastros" },
  "operator.cadastro.dados_updated": { label: "Cadastro: dados atualizados", category: "cadastros" },
  "operator.cadastro.deleted": { label: "Cadastro excluído", category: "cadastros" },
  "operator.cadastro.angellira_dispatched": { label: "Cadastro enviado ao Angellira", category: "cadastros" },
  "operator.cadastro.angellira_retry_step": { label: "Angellira: reprocessar etapa", category: "cadastros" },
  "operator.cadastro.angellira_pipeline_finished": { label: "Angellira: pipeline concluído", category: "cadastros" },
  "operator.cadastro.spx_dispatched": { label: "Cadastro enviado ao SPX", category: "cadastros" },
  "operator.cadastro.spx_step_failed": { label: "SPX: etapa falhou", category: "cadastros" },
  "operator.cadastro.dossie_generated": { label: "Dossiê gerado", category: "cadastros" },
  "operator.cadastro.dossie_failed": { label: "Dossiê: falha", category: "cadastros" },
  "operator.motorista.cadastro_rapido": { label: "Cadastro rápido de motorista", category: "cadastros" },
  "operator.driver.profile.updated": { label: "Motorista atualizado", category: "cadastros" },
  "driver.candidatura.submitted": { label: "Candidatura enviada", category: "cadastros" },
  "driver.candidatura.reused_existing_pending": { label: "Candidatura: pendente reaproveitada", category: "cadastros" },
  "driver.candidatura.draft_saved": { label: "Rascunho de candidatura salvo", category: "cadastros" },
  "driver.candidatura.draft_saved_anonymous": { label: "Rascunho salvo (anônimo)", category: "cadastros" },
  "driver.candidatura.draft_file_uploaded": { label: "Documento de candidatura enviado", category: "cadastros" },
  "public.cadastro.submitted": { label: "Cadastro público enviado", category: "cadastros" },

  // ── Cargas casadas (pacotes) ───────────────────────────────────────────────
  "operator.pacote.created": { label: "Pacote criado", category: "pacotes" },
  "operator.pacote.updated": { label: "Pacote atualizado", category: "pacotes" },
  "operator.pacote.published": { label: "Pacote publicado", category: "pacotes" },
  "operator.pacote.cancelled": { label: "Pacote cancelado", category: "pacotes" },
  "operator.pacote.cascade_cancelled": { label: "Pacote cancelado (cascata)", category: "pacotes" },
  "operator.pacote.cargas.reordered": { label: "Pacote: cargas reordenadas", category: "pacotes" },
  "operator.pacote.carga.added": { label: "Pacote: carga adicionada", category: "pacotes" },
  "operator.pacote.carga.removed": { label: "Pacote: carga removida", category: "pacotes" },

  // ── Segurança / Acessos ────────────────────────────────────────────────────
  "operator.request.denied": { label: "Requisição negada", category: "seguranca" },
  "operator.pacote.request.denied": { label: "Requisição de pacote negada", category: "seguranca" },
  "public-leads.pii.redacted": { label: "PII de lead redigida", category: "seguranca" },
  "public-leads.request.rate_limited": { label: "Requisição limitada (rate limit)", category: "seguranca" },

  // ── Sistema ─────────────────────────────────────────────────────────────────
  "system.route_catalog.imported": { label: "Catálogo de rotas importado", category: "sistema" },
};

/** Rótulo humano do evento (pt-BR); devolve o próprio event_type se desconhecido. */
export function resolveEventLabel(eventType) {
  return AUDIT_EVENT_CATALOG[eventType]?.label || eventType;
}

/** Categoria { key, label } do evento; "Outros" quando não catalogado. */
export function resolveEventCategory(eventType) {
  const key = AUDIT_EVENT_CATALOG[eventType]?.category;
  if (key && CATEGORY_LABELS.has(key)) {
    return { key, label: CATEGORY_LABELS.get(key) };
  }
  return { ...FALLBACK_CATEGORY };
}

/**
 * Traduz uma lista de chaves de categoria no conjunto de event_types que as
 * compõem (DC-185, filtro server-side). Ignora chaves desconhecidas.
 * Retorna [] quando nenhuma categoria válida foi informada.
 */
export function eventTypesForCategories(categoryKeys) {
  if (!Array.isArray(categoryKeys) || categoryKeys.length === 0) return [];
  const wanted = new Set(categoryKeys.filter((k) => CATEGORY_LABELS.has(k)));
  if (wanted.size === 0) return [];
  return Object.entries(AUDIT_EVENT_CATALOG)
    .filter(([, meta]) => wanted.has(meta.category))
    .map(([eventType]) => eventType);
}

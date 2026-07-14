/**
 * Humanização da tela de Auditoria — traduz os valores técnicos do log para
 * uma linguagem que o operador entende (sem códigos, siglas de tabela nem JSON).
 * Usado pela tela e pela exportação CSV (DC-184/185/186).
 */
import { formatCargoStatusLabel } from "./cargoStatus";
import { formatVehicleProfileLabel } from "./vehicleProfiles";

/** Tipo do recurso (tabela) → substantivo em pt-BR. UUID não é exibido ao operador. */
const RESOURCE_TYPE_LABELS: Record<string, string> = {
  route: "Rota",
  cargo: "Carga",
  cliente: "Cliente",
  driver_profile: "Motorista",
  driver_registration: "Cadastro",
  pending_driver_registration: "Cadastro pendente",
  pending_driver_documents_audit: "Documentos do cadastro",
  pacote: "Pacote (carga casada)",
  rota_cliente: "Vínculo rota–cliente",
  operator_endpoint: "Ação do painel",
  load_public_lead: "Reserva",
  route_catalog: "Catálogo de rotas",
};

/** Resultado técnico → pt-BR. */
const OUTCOME_LABELS: Record<string, string> = {
  success: "Sucesso",
  denied: "Negado",
  failure: "Falha",
  failed: "Falha",
  error: "Erro",
  rate_limited: "Limitado",
  blocked: "Bloqueado",
};

/** Severidade → pt-BR (info não vira selo). */
const SEVERITY_LABELS: Record<string, string> = {
  warning: "Atenção",
  error: "Erro",
  critical: "Crítico",
};

/** Chaves de metadata que fazem sentido mostrar ao operador (as demais são técnicas). */
const METADATA_FRIENDLY_LABELS: Record<string, string> = {
  motorista: "Motorista",
  lh: "LH",
  origem: "Origem",
  destino: "Destino",
  nome: "Nome",
  descricao: "Motivo",
  motivo: "Motivo",
  reason: "Motivo",
  status: "Status",
  cascadedCargaCount: "Cargas afetadas",
};

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Recurso legível: só o tipo em pt-BR (sem o UUID, que não diz nada ao operador). */
export function formatResourceLabel(
  resourceType: string | null | undefined,
): string {
  if (!resourceType) return "—";
  return RESOURCE_TYPE_LABELS[resourceType] ?? titleCase(resourceType.replace(/_/g, " "));
}

export function formatOutcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "—";
  return OUTCOME_LABELS[outcome] ?? titleCase(outcome.replace(/_/g, " "));
}

export function formatSeverityLabel(severity: string | null | undefined): string | null {
  if (!severity || severity === "info") return null;
  return SEVERITY_LABELS[severity] ?? titleCase(severity);
}

/**
 * Valor de um campo do antes→depois, humanizado por campo:
 *  - status → rótulo pt-BR (Aberta/Rascunho/…); status operacional livre vira Título;
 *  - perfil/veículo → rótulo canônico legível (nunca CARRETA_EXPRESSA cru);
 *  - boolean → Sim/Não; vazio → "(vazio)".
 */
export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "(vazio)";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(", ") : "(vazio)";
  const s = String(value);

  if (field === "status") {
    const enumLabel = formatCargoStatusLabel(s);
    return enumLabel !== s ? enumLabel : titleCase(s);
  }
  if (field === "perfil" || field === "vehicle_profile") {
    return formatVehicleProfileLabel(s);
  }
  return s;
}

/**
 * Extrai da metadata só as chaves úteis ao operador, já rotuladas em pt-BR.
 * Usado no detalhe de eventos SEM antes→depois (ex.: cadastro aprovado).
 */
export function friendlyMetadataEntries(
  metadata: Record<string, unknown> | null,
): Array<{ label: string; value: string }> {
  if (!metadata) return [];
  const entries: Array<{ label: string; value: string }> = [];
  for (const [key, label] of Object.entries(METADATA_FRIENDLY_LABELS)) {
    if (key === "changes") continue;
    const raw = metadata[key];
    if (raw === null || raw === undefined || raw === "" || Array.isArray(raw)) continue;
    entries.push({ label, value: formatAuditValue(key, raw) });
  }
  return entries;
}

/**
 * Repom (cadastro via WhatsApp) — rótulo derivado do progresso da coleta.
 *
 * O backend grava `dados.repom` (ver backend/src/application/repom/cnh-registration.js:
 * buildRepomProgress) no cadastro pendente, com `coleta_status` e `ultima_interacao`.
 * Aqui só TRADUZIMOS isso num selo pro operador — nada muda no banco, e cadastros
 * que não vieram do WhatsApp (sem `dados.repom`) não ganham selo.
 *
 * - coletando + interação recente → "EM ANDAMENTO" (o motorista ainda está mandando docs)
 * - coletando + parado há muito tempo → "PAROU" (o motorista sumiu; operador pode agir)
 * - concluida → "COMPLETO" (todos os docs chegaram; aguarda revisão do operador)
 */

/** Bloco `dados.repom` gravado pelo backend. */
export interface RepomProgress {
  origem?: string;
  coleta_status?: "coletando" | "concluida" | string;
  etapa_atual?: string | null;
  ultima_interacao?: string;
}

export type RepomBadgeTone = "andamento" | "parou" | "concluido";

export interface RepomBadge {
  label: string;
  tone: RepomBadgeTone;
  /** Rótulo do próximo doc esperado (quando coletando), ex.: "selfie com a CNH". */
  aguardando: string | null;
}

/** Sem interação por mais que isto → consideramos que o motorista "parou". */
export const REPOM_STALE_MS = 48 * 60 * 60 * 1000; // 48h

// Espelha os passos de backend/src/application/repom/repom-flow.js (REPOM_MOTORISTA_STEPS).
const ETAPA_LABEL: Record<string, string> = {
  cnh: "CNH",
  selfie_cnh: "selfie com a CNH",
  comprovante: "comprovante de residência",
  telefone: "telefone",
};

function extractRepom(dados: Record<string, unknown> | null | undefined): RepomProgress | null {
  if (!dados || typeof dados !== "object") return null;
  const repom = (dados as { repom?: unknown }).repom;
  if (!repom || typeof repom !== "object") return null;
  return repom as RepomProgress;
}

/**
 * Deriva o selo de progresso a partir de `dados.repom`.
 * @param now  epoch ms (injetável pra teste); default Date.now()
 * @returns o selo, ou null quando não é um cadastro do Repom.
 */
export function repomBadge(
  dados: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): RepomBadge | null {
  const repom = extractRepom(dados);
  if (!repom || repom.origem !== "whatsapp") return null;

  if (repom.coleta_status === "concluida") {
    return { label: "COMPLETO", tone: "concluido", aguardando: null };
  }

  const aguardando = repom.etapa_atual ? ETAPA_LABEL[repom.etapa_atual] ?? repom.etapa_atual : null;
  const ts = repom.ultima_interacao ? Date.parse(repom.ultima_interacao) : NaN;
  const parou = Number.isFinite(ts) && now - ts > REPOM_STALE_MS;
  return parou
    ? { label: "PAROU", tone: "parou", aguardando }
    : { label: "EM ANDAMENTO", tone: "andamento", aguardando };
}

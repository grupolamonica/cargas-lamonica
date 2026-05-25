/**
 * Constantes compartilhadas para a feature "cargas casadas" (pacote).
 * Mirror das constantes server-side em
 * `backend/src/domain/cargas-casadas/constants.js`. Manter em sincronia.
 */
export const MAX_CARGAS_POR_PACOTE = 3;

export const PACOTE_STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho",
  publicado: "Publicado",
  reservado: "Reservado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
  cancelado: "Cancelado",
};

export const PACOTE_STATUS_BADGE: Record<string, { bg: string; dot: string }> = {
  rascunho: { bg: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  publicado: { bg: "bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" },
  reservado: { bg: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  em_andamento: { bg: "bg-teal-50 text-teal-800", dot: "bg-teal-500" },
  concluido: { bg: "bg-blue-50 text-blue-800", dot: "bg-blue-500" },
  cancelado: { bg: "bg-zinc-100 text-zinc-600", dot: "bg-zinc-400" },
};

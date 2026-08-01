import type { ProgramacaoRow } from "@/services/readModels";

/**
 * Linha do Planejado que a tela esconde por ATRASO.
 *
 * A tela reavalia o atraso a cada tick do relógio (não só no fetch), então a regra vive
 * aqui — pura e testável — em vez de embutida no filtro da página.
 *
 * Espelha o backend (get-programacao.js): Planejado atrasado é backlog inútil e sai do
 * painel, MENOS quando a viagem já tem motorista atribuído — essa não migra para a aba
 * Aceito (que só recebe viagem em execução) e esconder daqui a apagaria das três abas.
 *
 * Assimetria proposital com o backend: sem `carregamentoTs` o front NÃO esconde (o
 * backend tem fallback por data+horário; aqui, na dúvida, mostrar é mais seguro do que
 * sumir com a linha).
 */
export function isHiddenLatePlanejado(
  row: Pick<ProgramacaoRow, "tab" | "carregamentoTs" | "motorista">,
  nowMs: number,
): boolean {
  if (row.tab !== "planejado") return false;
  if (!row.carregamentoTs) return false;
  if (row.carregamentoTs * 1000 >= nowMs) return false;
  return !String(row.motorista ?? "").trim();
}

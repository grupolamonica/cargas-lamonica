// DC-310 — diferenciação de motoristas HOMÔNIMOS nas telas de Alocação/Monitor.
//
// Dois motoristas com o mesmo nome (ex.: "Antonio Cezar de Jesus") ficam
// indistinguíveis quando só o nome é exibido — risco de alocar/consultar o errado.
// Aqui detectamos homônimos (mesmo nome, CPFs distintos) e formatamos o nome com os
// 3 ÚLTIMOS dígitos do CPF, ex.: `Antonio Cezar de Jesus (***123)`.
//
// LGPD: NUNCA expor o CPF completo — no máximo os 3 últimos dígitos.

const NON_DIGITS = /\D+/g;
// Sufixo que a UI acrescenta p/ homônimos: " (***123)" (2–4 estrelas, 1–3 dígitos).
const CPF_SUFFIX_RE = /\s*\(\*{2,4}\d{1,3}\)\s*$/;

/** Últimos 3 dígitos do CPF/documento como "***123"; "" quando não há dígitos suficientes. */
export function cpfSuffix3(document: string | null | undefined): string {
  const digits = String(document ?? "").replace(NON_DIGITS, "");
  if (digits.length < 3) return "";
  return `***${digits.slice(-3)}`;
}

/** Normaliza o nome p/ chave de comparação (sem acento, minúsculo, espaços colapsados). */
export function normalizeDriverName(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export interface HomonymDriverInput {
  displayName: string | null | undefined;
  document: string | null | undefined;
}

export interface HomonymIndex {
  /** true quando o nome é compartilhado por 2+ CPFs distintos (homônimo). */
  isHomonym(name: string | null | undefined): boolean;
  /** Nome com sufixo `(***NNN)` quando homônimo e CPF conhecido; senão o nome cru. */
  labelFor(name: string, document?: string | null): string;
  /** Quantidade de CPFs distintos vistos para o nome (0 se desconhecido). */
  distinctCount(name: string | null | undefined): number;
}

/**
 * Constrói o índice de homônimos a partir da lista de motoristas conhecidos
 * (nome → CPFs distintos). Motoristas sem CPF não contam para a desambiguação.
 */
export function buildHomonymIndex(drivers: HomonymDriverInput[]): HomonymIndex {
  const byName = new Map<string, Set<string>>();
  for (const d of drivers) {
    const key = normalizeDriverName(d.displayName);
    if (!key) continue;
    const suffix = cpfSuffix3(d.document);
    if (!suffix) continue; // sem CPF → não ajuda a distinguir
    let set = byName.get(key);
    if (!set) {
      set = new Set();
      byName.set(key, set);
    }
    set.add(suffix);
  }
  const distinctCount = (name: string | null | undefined) => byName.get(normalizeDriverName(name))?.size ?? 0;
  const isHomonym = (name: string | null | undefined) => distinctCount(name) > 1;
  const labelFor = (name: string, document?: string | null) => {
    if (!isHomonym(name)) return name;
    const suffix = cpfSuffix3(document);
    return suffix ? `${name} (${suffix})` : name;
  };
  return { isHomonym, labelFor, distinctCount };
}

/**
 * Remove o sufixo de CPF `(***123)` que a UI acrescenta aos homônimos ANTES de gravar
 * — o nome persistido (planilha/ASPX/relatórios) tem de continuar limpo. Idempotente e
 * seguro em nomes normais (no-op).
 */
export function stripDriverCpfSuffix(value: string | null | undefined): string {
  return String(value ?? "").replace(CPF_SUFFIX_RE, "").trim();
}

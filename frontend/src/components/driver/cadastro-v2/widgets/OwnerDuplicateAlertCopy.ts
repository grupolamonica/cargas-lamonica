import type { VerifyDocumentResponse } from "@/api/candidaturaApi";

/**
 * 2026-05-18 — Constroi o copy para o DriverAlert info que aparece nos Steps
 * C (proprietario cavalo) e E (proprietario carreta) quando `verifyDocument`
 * detecta que o owner CRLV ja esta cadastrado em algum lugar (AngelLira,
 * ASPX ou DB local da Lamonica).
 *
 * Mantemos PII fora do texto: somente origem da fonte + datas formatadas.
 */

export interface OwnerDuplicateCopy {
  title: string;
  description: string;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const dd = String(parsed.getDate()).padStart(2, "0");
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const yyyy = parsed.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function describeSource(source: "angellira" | "aspx" | "both" | undefined): string {
  if (source === "both") return "Encontrei o cadastro na AngelLira e ASPX.";
  if (source === "angellira") return "Encontrei o cadastro na AngelLira.";
  if (source === "aspx") return "Encontrei o cadastro na ASPX.";
  // Sem fonte externa → cadastro local apenas.
  return "Encontrei o cadastro no nosso sistema.";
}

export function buildOwnerDuplicateAlert(
  result: VerifyDocumentResponse | null,
): OwnerDuplicateCopy {
  const parts: string[] = [];
  parts.push(describeSource(result?.externalRegistration?.source));

  const situacao = result?.externalRegistration?.situacao;
  if (typeof situacao === "string" && situacao.trim().length > 0) {
    parts.push(`Situação: ${situacao.trim()}.`);
  }

  const lastUpdated = formatDate(
    result?.lastCandidatura?.lastUpdatedAt ?? result?.lastCandidatura?.candidatedAt ?? null,
  );
  if (lastUpdated) {
    parts.push(`Última candidatura em ${lastUpdated}.`);
  }

  return {
    title: "Esse proprietário já está cadastrado na Lamônica",
    description: parts.join(" "),
  };
}

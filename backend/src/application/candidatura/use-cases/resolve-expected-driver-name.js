import { lookupAngelliraDriverByCpf } from "../../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../../infrastructure/aspx/aspx-directory.js";

/**
 * Resolve o nome "esperado" de um CPF a partir dos registros EXTERNOS
 * (Angellira → ASPX) — a fonte-da-verdade INFORJÁVEL para conferir a identidade
 * da candidatura contra o nome digitado. O CPF é o identificador; o nome vem de
 * fora, então nem omitir/forjar o snapshot da CNH no payload burla a checagem.
 *
 * Best-effort: qualquer falha/ausência/CPF novo devolve "" (fail-open — não
 * barra; motorista ainda não cadastrado externamente é caso legítimo). As duas
 * consultas já são resilientes (retornam displayName:null em erro) e cacheadas
 * (o pré-check costuma tê-las aquecido).
 *
 * @param {string} cpf
 * @param {{correlationId?:string, timeoutMs?:number}} [options]
 * @returns {Promise<string>} displayName resolvido, ou "" quando indisponível.
 */
export async function resolveExpectedDriverName(cpf, { correlationId, timeoutMs = 4000 } = {}) {
  const digits = String(cpf || "").replace(/\D/g, "");
  if (digits.length !== 11) return "";

  const resolveName = async () => {
    try {
      const ang = await lookupAngelliraDriverByCpf(digits, { correlationId });
      if (ang?.found && ang.displayName) return String(ang.displayName).trim();
    } catch {
      /* fail-open — indisponibilidade não pode travar o cadastro */
    }
    try {
      const aspx = await lookupAspxDriverByCpf(digits, { correlationId });
      if (aspx?.displayName) return String(aspx.displayName).trim();
    } catch {
      /* fail-open */
    }
    return "";
  };

  // Deadline curto: no onset de uma queda do Angellira (antes do circuit breaker
  // abrir) a consulta pode levar dezenas de segundos. Fail-open ("") mantém o
  // submit responsivo; a consulta pendente ainda popula o cache p/ a próxima.
  const deadline = new Promise((resolve) => {
    setTimeout(() => resolve(""), timeoutMs);
  });
  return Promise.race([resolveName(), deadline]);
}

// Traduz o erro cru da fila de envio (campo `last_error`) para uma mensagem
// simples e legível pelo operador. Erros técnicos (Evolution/HTTP/rede) viram
// texto amigável; códigos internos viram frases; mensagens que já são humanas
// passam direto.
//
// O texto cru continua salvo no banco (`last_error`) para depuração — aqui é
// apenas apresentação. Ex. do erro que motivou isto (WhatsApp desconectado):
//   Error: EVOLUTION_HTTP_500:{"status":500,"error":"Internal Server Error",
//   "response":{"message":"Connection Closed"}}

export function friendlyOutreachError(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const low = s.toLowerCase();

  // 1) Códigos internos conhecidos (não são erros técnicos, mas caem no campo).
  if (low === "opted_out")
    return "Motorista está na lista de não perturbe (opt-out).";
  if (low === "cold_disabled")
    return "Gatilho frio desativado na configuração.";
  if (low === "not_in_test_allowlist")
    return "Envio de teste: número fora da lista permitida.";

  // 2) WhatsApp desconectado / instável — causa mais comum do 500 "Connection Closed".
  const disconnected =
    low.includes("connection closed") ||
    low.includes("evolution_http_500") ||
    low.includes("evolution_http_502") ||
    low.includes("evolution_http_503") ||
    low.includes("not_created") ||
    low.includes("connectionstate") ||
    low.includes("disconnected");
  if (disconnected)
    return "WhatsApp desconectado ou instável no momento. Reconecte o número na aba Automação e tente enviar novamente.";

  // 3) Autenticação com o gateway.
  if (low.includes("evolution_http_401") || low.includes("evolution_http_403"))
    return "Falha de autenticação com o WhatsApp. Verifique a conexão na aba Automação.";

  // 4) Número/telefone inválido ou requisição malformada.
  if (
    low.includes("evolution_http_400") ||
    (low.includes("invalid") && low.includes("number")) ||
    low.includes("bad request")
  )
    return "Não foi possível enviar: confira o número de telefone do motorista.";

  // 5) Serviço fora do ar / problema de rede.
  if (
    low.includes("econnrefused") ||
    low.includes("etimedout") ||
    low.includes("enotfound") ||
    low.includes("fetch failed") ||
    low.includes("timeout") ||
    low.includes("socket hang up") ||
    low.includes("network")
  )
    return "Não foi possível falar com o serviço de WhatsApp agora. Tente novamente em instantes.";

  // 6) Serviço não configurado.
  if (low.includes("not_configured") || low.includes("no_token"))
    return "Serviço de WhatsApp não configurado. Fale com o suporte.";

  // 7) Qualquer coisa que "cheira" a técnico (Error:, HTTP_500, JSON, código
  //    snake_case) vira uma mensagem genérica — o operador não veria gibberish.
  const looksTechnical =
    /error|exception|traceback|\bhttp[_ ]?\d{3}\b|[{}[\]]|https?:\/\//i.test(s) ||
    /^[a-z]+(?:_[a-z]+)+$/i.test(s);
  if (looksTechnical)
    return "Não foi possível enviar agora. Tente novamente; se o problema continuar, verifique a conexão do WhatsApp na aba Automação.";

  // 8) Já é uma mensagem legível (ex.: "cancelado pelo operador",
  //    "já cadastrado no Angellira (vigente até 28/09/2026)").
  return s;
}

/**
 * Corrige texto português com mojibake "?" no lugar de acentos perdidos.
 *
 * Uso somente em display — não substitui correção no DB. Aplica padrões
 * inequívocos do português: "S?o" → "São", "n?o" → "não", etc.
 *
 * Idempotente: textos já corretos passam intactos. Limita troca a palavras
 * onde o contexto não deixa ambiguidade.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Topônimos brasileiros
  [/\bS\?o\s+(Paulo|Bernardo|Caetano|Vicente|Carlos|Jos[eé]?|Sebasti[ãa]o|Louren[çc]o|Gon[çc]alo|Lu[ií]s|Roque|Mateus|Jo[ãa]o|Miguel)\b/gi, "São $1"],
  [/\bSanto\s+Andr\?\b/gi, "Santo André"],
  [/\bAvar\?\b/gi, "Avaré"],
  [/\bItarar\?\b/gi, "Itararé"],
  [/\bGoi\?nia\b/gi, "Goiânia"],
  [/\bBras\?lia\b/gi, "Brasília"],
  [/\bMaranh\?o\b/gi, "Maranhão"],
  [/\bTabo\?o\b/gi, "Taboão"],
  [/\bPar\?\b/gi, "Pará"],
  [/\bCear\?\b/gi, "Ceará"],
  [/\bPiau\?\b/gi, "Piauí"],
  [/\bAndr\?\b/gi, "André"],
  [/\bJo\?o\b/gi, "João"],
  [/\bJer\?nimo\b/gi, "Jerônimo"],
  [/\bIlh\?us\b/gi, "Ilhéus"],

  // Palavras comuns português
  [/\bS\?o\b/g, "São"],
  [/\bs\?o\b/g, "são"],
  [/\bN\?o\b/g, "Não"],
  [/\bn\?o\b/g, "não"],
  [/\b([Dd])ecis\?o\b/g, "$1ecisão"],
  [/\b([Ee])xig\?ncia\b/g, "$1xigência"],
  [/\b([Ee])xig\?ncias\b/g, "$1xigências"],
  [/\b([Rr])eputa\?\?o\b/g, "$1eputação"],
  [/\b([Rr])eputa\?\?es\b/g, "$1eputações"],
  [/\b([Oo])bserva\?\?o\b/g, "$1bservação"],
  [/\b([Oo])bserva\?\?es\b/g, "$1bservações"],
  [/\b([Oo])pera\?\?o\b/g, "$1peração"],
  [/\b([Oo])pera\?\?es\b/g, "$1perações"],
  [/\b([Dd])escri\?\?o\b/g, "$1escrição"],
  [/\b([Nn])otifica\?\?o\b/g, "$1otificação"],
  [/\b([Nn])otifica\?\?es\b/g, "$1otificações"],
  [/\b([Ii])nforma\?\?o\b/g, "$1nformação"],
  [/\b([Ii])nforma\?\?es\b/g, "$1nformações"],
  [/\b([Cc])onfigura\?\?o\b/g, "$1onfiguração"],
  [/\b([Aa])prova\?\?o\b/g, "$1provação"],
  [/\b([Ff])un\?\?o\b/g, "$1unção"],
  [/\b([Ss])e\?\?o\b/g, "$1eção"],
  [/\b([Ss])ele\?\?o\b/g, "$1eleção"],
  [/\b([Cc])onex\?o\b/g, "$1onexão"],
  [/\b([Mm])anuten\?\?o\b/g, "$1anutenção"],
  [/\b([Dd])ura\?\?o\b/g, "$1uração"],
  [/\b([Ii])nscri\?\?o\b/g, "$1nscrição"],
  [/\b([Ee])ndere\?o\b/g, "$1ndereço"],
  [/\b([Ss])ervi\?o\b/g, "$1erviço"],
  [/\b([Ss])ervi\?os\b/g, "$1erviços"],
  [/\b([Pp])re\?o\b/g, "$1reço"],
  [/\b([Pp])e\?a\b/g, "$1eça"],
  [/\b([Pp])e\?as\b/g, "$1eças"],
  [/\b([Hh])or\?rio\b/g, "$1orário"],
  [/\b([Uu])su\?rio\b/g, "$1suário"],
  [/\b([Uu])su\?rios\b/g, "$1suários"],
  [/\b([Pp])\?blico\b/g, "$1úblico"],
  [/\b([Pp])\?blica\b/g, "$1ública"],
  [/\b([Pp])\?gina\b/g, "$1ágina"],
  [/\b([Rr])\?pido\b/g, "$1ápido"],
  [/\b([Rr])\?pida\b/g, "$1ápida"],
  [/\b([Dd])ist\?ncia\b/g, "$1istância"],
  [/\b([Rr])efer\?ncia\b/g, "$1eferência"],
  [/\b([Hh])ist\?rico\b/g, "$1istórico"],
  [/\b([Hh])ist\?ria\b/g, "$1istória"],
  [/\b([Vv])ig\?ncia\b/g, "$1igência"],
  [/\b([Pp])er\?odo\b/g, "$1eríodo"],
  [/\b([Vv])e\?culo\b/g, "$1eículo"],
  [/\b([Vv])e\?culos\b/g, "$1eículos"],
  [/\b([Cc])\?digo\b/g, "$1ódigo"],
  [/\b([Cc])\?digos\b/g, "$1ódigos"],
  [/\b([Pp])adr\?o\b/g, "$1adrão"],
  [/\b([Cc])omunica\?\?o\b/g, "$1omunicação"],
  [/\b([Ll])ibera\?\?o\b/g, "$1iberação"],
  [/\b([Aa])ten\?\?o\b/g, "$1tenção"],
  [/\b([Aa])\?\?o\b/g, "$1ção"],
];

export function fixBrokenPortugueseText<T extends string | null | undefined>(value: T): T {
  if (!value || typeof value !== "string") {
    return value;
  }
  if (!value.includes("?")) {
    return value;
  }
  let result = value as string;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result as T;
}

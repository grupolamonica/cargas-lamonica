/**
 * Higiene do localStorage (DC-283 / MED-4).
 *
 * O rascunho do cadastro guarda a ficha inteira do motorista — CNH, CPF,
 * endereço, dados bancários — em `lamonica-cadastro-v2-draft:<dono>`. Dois
 * buracos concretos nisso:
 *
 * 1. **O TTL de 72h só era checado na LEITURA.** Um rascunho abandonado nunca
 *    mais lido nunca expira de fato: a PII fica no aparelho para sempre. Numa
 *    cabine compartilhada ou num celular que trocou de dono, "para sempre" é
 *    literal.
 *
 * 2. **Sair da conta não limpava nada disso.** O supabase-js remove a própria
 *    chave de sessão e pronto; a ficha do motorista anterior continuava legível
 *    por qualquer JS na página — e por qualquer pessoa que abrisse o DevTools.
 *
 * O que este módulo NÃO resolve: os tokens de sessão seguem em localStorage
 * (`lamonica-operator-auth` / `lamonica-driver-auth`), legíveis por qualquer
 * script que execute na página. Tirar de lá exige migrar para cookie
 * httpOnly/SameSite, que muda o fluxo de autenticação inteiro — trabalho
 * próprio. Enquanto isso, quem segura essa ponta é a CSP.
 */

const DRAFT_STORAGE_PREFIX = "lamonica-cadastro-v2-draft";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Modo privado / storage bloqueado por política: higiene é best-effort e
    // nunca pode derrubar a aplicação.
    return null;
  }
}

function draftKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(DRAFT_STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Remove rascunhos já vencidos. Roda no boot da aplicação para que o TTL de 72h
 * valha mesmo quando o rascunho nunca mais é aberto.
 *
 * Entrada corrompida ou sem `expiresAt` também sai: não dá para saber quando
 * expira, e é PII sem prazo.
 *
 * @returns quantidade removida (útil em teste).
 */
export function purgeExpiredRegistrationDrafts(now: number = Date.now()): number {
  const storage = safeLocalStorage();
  if (!storage) return 0;

  let removed = 0;
  for (const key of draftKeys(storage)) {
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      const expiresAt = typeof parsed?.expiresAt === "number" ? parsed.expiresAt : null;

      if (expiresAt === null || expiresAt <= now) {
        storage.removeItem(key);
        removed += 1;
      }
    } catch {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Apaga TODO rascunho de cadastro guardado localmente. Chamado ao sair da conta,
 * nos dois portais: o operador também abre o wizard no modo resgate, então a
 * ficha de um motorista pode ter ficado no aparelho dele.
 *
 * Não mexe nas chaves de sessão — quem cuida delas é o próprio supabase-js, e
 * limpar todas aqui derrubaria a outra sessão quando operador e motorista
 * dividem o mesmo navegador.
 *
 * @returns quantidade removida (útil em teste).
 */
export function clearStoredRegistrationDrafts(): number {
  const storage = safeLocalStorage();
  if (!storage) return 0;

  const keys = draftKeys(storage);
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

import { resolveCanonicalApiRequestUrl } from "@/lib/runtimeOrigin";

/**
 * Beacon do ciclo de autenticação (DC-283 / ALTO-16).
 *
 * O login roda no GoTrue do lado do cliente, então o backend nunca vê a sessão
 * nascer — "quem entrou no sistema, quando e de onde" simplesmente não existia
 * na trilha de auditoria. Este aviso fecha a lacuna.
 *
 * Três decisões:
 *
 * 1. **Best-effort, sempre.** Nenhuma falha aqui pode atrapalhar o login: se a
 *    rede cair ou o backend recusar, o usuário entra do mesmo jeito. Auditoria
 *    que derruba autenticação é pior que auditoria ausente.
 *
 * 2. **Só o tipo de evento vai no corpo.** Quem é o ator sai do Bearer token no
 *    servidor — nunca do que o cliente afirma —, então não há como registrar
 *    login em nome de outra pessoa.
 *
 * 3. **`SIGNED_IN` dispara em toda revalidação de sessão** (o supabase-js emite
 *    ao reidratar de storage e ao renovar token). Sem deduplicação, cada F5
 *    viraria um "login" e a trilha ficaria inútil por volume. O guard abaixo
 *    registra uma vez por token.
 */
const SESSION_EVENT_PATH = "/api/auth/session-event";

let lastReportedToken: string | null = null;

export function resetAuthBeaconStateForTests(): void {
  lastReportedToken = null;
}

async function postSessionEvent(event: "signed_in" | "signed_out", accessToken: string) {
  try {
    await fetch(resolveCanonicalApiRequestUrl(SESSION_EVENT_PATH), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ event }),
      keepalive: true,
    });
  } catch {
    /* best-effort — ver decisão 1 acima */
  }
}

/** Registra a entrada uma única vez por token de sessão. */
export function reportSignedIn(accessToken: string | null | undefined): void {
  if (!accessToken || accessToken === lastReportedToken) return;
  lastReportedToken = accessToken;
  void postSessionEvent("signed_in", accessToken);
}

/**
 * Registra a saída. Precisa ser chamada ANTES de `signOut()`: depois, não há
 * mais token para provar quem estava saindo.
 */
export function reportSigningOut(accessToken: string | null | undefined): void {
  lastReportedToken = null;
  if (!accessToken) return;
  void postSessionEvent("signed_out", accessToken);
}

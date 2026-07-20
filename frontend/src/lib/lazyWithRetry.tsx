import { lazy, type ComponentType } from "react";

// DC-265 — "recarregue a página" no /motorista (mobile).
//
// As páginas são carregadas via import() dinâmico (React.lazy). Após um deploy,
// os chunks têm um novo hash no nome; a aba que o motorista deixou aberta ainda
// tem o index.html antigo, que referencia chunks que não existem mais. O
// import() falha e, sem tratamento, cai no ErrorBoundary ("Algo deu errado —
// recarregue a página"). É constante no celular, onde a aba fica horas aberta e
// os deploys são frequentes. Uma falha transitória de rede móvel no fetch do
// chunk cai no mesmo caminho.
//
// Aqui recarregamos a página UMA vez ao detectar a falha — o reload busca o
// index.html + chunks novos e o motorista segue sem ver a tela de erro. Um flag
// em sessionStorage evita loop de reload: se logo após recarregar o import ainda
// falhar (erro real, não chunk velho), o erro sobe para o ErrorBoundary.

const RELOAD_KEY = "lmc:chunk-reloaded";

/**
 * Recarrega a página uma única vez para buscar os assets novos após um deploy.
 * Retorna `true` se disparou o reload; `false` se já recarregou nesta sessão
 * (evita loop) ou se o sessionStorage está indisponível (modo privado) — nesse
 * caso preferimos não arriscar um loop e deixamos o erro seguir.
 */
export function reloadOnceForStaleChunk(): boolean {
  try {
    if (window.sessionStorage.getItem(RELOAD_KEY)) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Limpa o flag após um carregamento bem-sucedido — re-arma para um deploy futuro. */
export function clearStaleChunkReloadFlag(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* sessionStorage indisponível — nada a limpar */
  }
}

/**
 * Núcleo testável: resolve o módulo; em falha, recarrega uma vez (retornando uma
 * promise pendente, pois a página vai recarregar) ou propaga o erro se o reload
 * já foi tentado.
 */
export async function importWithReload<T>(factory: () => Promise<T>): Promise<T> {
  try {
    const mod = await factory();
    clearStaleChunkReloadFlag();
    return mod;
  } catch (error) {
    if (reloadOnceForStaleChunk()) {
      // A página vai recarregar; a promise pendente impede o React de renderizar
      // o estado de erro no intervalo até o reload acontecer.
      return new Promise<T>(() => {});
    }
    throw error;
  }
}

/**
 * Drop-in para `React.lazy` com auto-recuperação de chunk stale (pós-deploy) e
 * falhas transitórias de rede móvel no import() dinâmico.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() => importWithReload(factory));
}

/**
 * Registra o handler do evento `vite:preloadError` — disparado pelo runtime do
 * Vite quando o preload de um chunk dinâmico falha (mesmo cenário de chunk
 * stale). Recarrega uma vez em vez de deixar o Vite lançar o erro.
 */
export function installStaleChunkReloadHandler(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reloadOnceForStaleChunk();
  });
}

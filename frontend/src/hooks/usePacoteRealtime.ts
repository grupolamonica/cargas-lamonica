import { useEffect } from "react";
import { publicSupabase } from "@/integrations/supabase/public-client";

/**
 * Row publica de `cargas_casadas` recebida via Supabase Realtime (UPDATE).
 * Espelha o shape do payload `payload.new` quando o operador edita um pacote.
 *
 * Status é a união completa do enum no schema (plan 10-01), mesmo que somente
 * `publicado | reservado | em_andamento` sejam expostos publicamente — RLS
 * filtra fora os demais, mas mantemos o tipo amplo para suportar transições
 * (ex: `publicado` → `cancelado`) recebidas durante a edição.
 */
export interface PacoteRealtimeRow {
  id: string;
  status:
    | "rascunho"
    | "publicado"
    | "reservado"
    | "em_andamento"
    | "concluido"
    | "cancelado";
  valor_total: number;
  version: number;
}

export interface UsePacoteRealtimeOptions {
  /** ID do pacote — se null/undefined, hook não subscreve (carga avulsa). */
  pacoteId: string | null | undefined;
  /** Última `version` conhecida no cache local — dispara onVersionBump quando o payload trouxer `version > currentVersion`. */
  currentVersion: number;
  /** Callback executado quando UPDATE traz version maior que a atual. Memoize via useCallback para evitar re-subscribe. */
  onVersionBump: (next: PacoteRealtimeRow) => void;
}

/**
 * Subscribe a UPDATE events em `cargas_casadas` filtrados pelo `id` do pacote
 * via Supabase Realtime. Quando o payload novo trouxer `version` maior que a
 * `currentVersion` local, dispara `onVersionBump(payload.new)` — geralmente o
 * caller usa para `toast.info` + `queryClient.invalidateQueries`.
 *
 * Cleanup: `removeChannel` no unmount + sempre que pacoteId muda.
 *
 * Plan 10-06 (CARGAS-CASADAS-04, CARGAS-CASADAS-06).
 */
export function usePacoteRealtime({
  pacoteId,
  currentVersion,
  onVersionBump,
}: UsePacoteRealtimeOptions): void {
  useEffect(() => {
    if (!pacoteId) {
      return undefined;
    }

    const channel = publicSupabase
      .channel(`pacote-${pacoteId}`)
      .on(
        // Tipagem do `.on("postgres_changes", ...)` no @supabase/supabase-js
        // ainda exige cast quando o filter é dinâmico — todos os demais
        // callers em codebase fazem o mesmo (ver DriverPortal.tsx).
        "postgres_changes" as unknown as never,
        {
          event: "UPDATE",
          schema: "public",
          table: "cargas_casadas",
          filter: `id=eq.${pacoteId}`,
        } as never,
        (payload: { new: PacoteRealtimeRow | null }) => {
          const next = payload.new;
          if (next && typeof next.version === "number" && next.version > currentVersion) {
            onVersionBump(next);
          }
        },
      )
      .subscribe();

    return () => {
      void publicSupabase.removeChannel(channel);
    };
  }, [pacoteId, currentVersion, onVersionBump]);
}

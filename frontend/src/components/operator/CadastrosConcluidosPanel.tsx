import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldX, Trophy } from "lucide-react";
import { useState } from "react";

import AdminPagination from "@/components/AdminPagination";
import { fetchCadastrosPendentes } from "@/services/readModels";

/**
 * Aba "Concluídas": cadastros com `status='concluido'` — motorista + cavalo +
 * carreta conformes no Angellira (homologação finalizada). Read-only e derivado;
 * a conclusão é feita pelo reconcile com o Angellira (nenhuma linha muda aqui).
 */
export function CadastrosConcluidosPanel() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "cadastros-concluidos", page],
    queryFn: () => fetchCadastrosPendentes({ status: "concluido", page, pageSize: 20 }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const meta = data?.meta;

  if (isLoading) {
    return (
      <section className="admin-panel flex min-h-[160px] items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary/60" />
      </section>
    );
  }
  if (error) {
    return (
      <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldX className="h-10 w-10 text-rose-500/70" />
        <p className="text-sm text-muted-foreground">Erro ao carregar os cadastros concluídos.</p>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
        <Trophy className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Nenhum cadastro concluído ainda.</p>
      </section>
    );
  }

  return (
    <section className="admin-panel overflow-hidden">
      <ul className="divide-y divide-border/60">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-4 lg:p-5">
            <div className="min-w-0">
              <p className="font-semibold text-foreground">{item.nome_motorista || "—"}</p>
              <p className="text-xs text-muted-foreground">
                {item.cpf_motorista || ""}
                {item.placa_cavalo ? ` · ${item.placa_cavalo}` : ""}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Concluído
            </span>
          </li>
        ))}
      </ul>
      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {meta.totalCount} cadastro{meta.totalCount !== 1 ? "s" : ""} concluído{meta.totalCount !== 1 ? "s" : ""}
          </p>
          <AdminPagination
            page={page}
            totalPages={meta.totalPages}
            totalCount={meta.totalCount}
            pageSize={20}
            itemLabel="cadastro(s)"
            isFetching={isFetching}
            onPrevious={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
          />
        </div>
      ) : null}
    </section>
  );
}

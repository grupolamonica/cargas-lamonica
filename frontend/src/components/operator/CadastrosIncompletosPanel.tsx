import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ClipboardList, FileWarning, Loader2, ShieldX } from "lucide-react";
import { useState } from "react";

import AdminPagination from "@/components/AdminPagination";
import { cn } from "@/lib/utils";
import { fetchCadastrosIncompletos, type CadastroProblema } from "@/services/readModels";

const AREA_LABEL: Record<string, string> = {
  motorista: "Motorista",
  cavalo: "Cavalo",
  carreta: "Carreta",
  proprietario: "Proprietário",
};

function tipoClasses(tipo: CadastroProblema["tipo"]) {
  return tipo === "nao_conforme"
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : "border-amber-200 bg-amber-50 text-amber-700";
}

/**
 * Sub-aba "Dados incompletos": cadastros pendentes que não dá pra revisar porque
 * têm dado faltando ou não conforme (motorista/cavalo/carreta/proprietário), cada
 * um com o motivo. Read-only e derivado — nenhuma linha muda de status no banco.
 */
export function CadastrosIncompletosPanel() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "cadastros-incompletos", page],
    queryFn: () => fetchCadastrosIncompletos({ page, pageSize: 20 }),
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
        <p className="text-sm text-muted-foreground">Erro ao carregar os cadastros com dados incompletos.</p>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
        <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Nenhum cadastro com dados incompletos. 🎉</p>
      </section>
    );
  }

  return (
    <section className="admin-panel overflow-hidden">
      <ul className="divide-y divide-border/60">
        {items.map((item) => (
          <li key={item.id} className="p-4 lg:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{item.nome_motorista || "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {item.cpf_motorista || ""}
                  {item.placa_cavalo ? ` · ${item.placa_cavalo}` : ""}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                <FileWarning className="h-3.5 w-3.5" /> {item.n_problemas}{" "}
                {item.n_problemas === 1 ? "pendência" : "pendências"}
              </span>
            </div>
            <ul className="mt-3 space-y-1.5">
              {item.problemas.map((problema, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"
                >
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide",
                      tipoClasses(problema.tipo),
                    )}
                  >
                    {AREA_LABEL[problema.area] ?? problema.area}
                  </span>
                  <span className="text-foreground">
                    {problema.motivo}
                    {problema.tipo === "nao_conforme" ? (
                      <span className="ml-1 text-xs text-rose-600">(não conforme)</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {meta.totalCount} cadastro{meta.totalCount !== 1 ? "s" : ""} com dados incompletos
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

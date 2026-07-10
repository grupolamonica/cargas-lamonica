import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, Loader2, ShieldX } from "lucide-react";
import { useState } from "react";

import AdminPagination from "@/components/AdminPagination";
import { cn } from "@/lib/utils";
import { fetchCadastrosComErro } from "@/services/readModels";

type Origem = "angellira" | "spx" | undefined;

const ORIGENS: { key: Origem; label: string }[] = [
  { key: undefined, label: "Todos" },
  { key: "angellira", label: "Angellira" },
  { key: "spx", label: "SPX" },
];

function targetLabel(t: string) {
  if (t === "angellira") return "Angellira";
  if (t === "spx") return "SPX";
  return t;
}

/**
 * Sub-aba "Com erro" (DC-196): lista os cadastros cujo cadastro externo
 * (Angellira/SPX) falhou, com a causa e a ação sugerida. Read-only,
 * auto-derivado de external_registration_jobs.
 */
export function CadastrosComErroPanel() {
  const [origem, setOrigem] = useState<Origem>(undefined);
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "cadastros-com-erro", origem ?? "todos", page],
    queryFn: () => fetchCadastrosComErro({ origem, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const meta = data?.meta;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {ORIGENS.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => {
              setOrigem(o.key);
              setPage(1);
            }}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
              origem === o.key ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <section className="admin-panel flex min-h-[160px] items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary/60" />
        </section>
      ) : error ? (
        <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
          <ShieldX className="h-10 w-10 text-rose-500/70" />
          <p className="text-sm text-muted-foreground">Erro ao carregar cadastros com erro.</p>
        </section>
      ) : items.length === 0 ? (
        <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
          <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Nenhum cadastro com erro{origem ? ` no ${targetLabel(origem)}` : ""}.
          </p>
        </section>
      ) : (
        <section className="admin-panel overflow-hidden">
          <ul className="divide-y divide-border/60">
            {items.map((item) => (
              <li key={item.id} className="p-4 lg:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">{item.nome_motorista || "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.cpf_motorista || ""}
                      {item.placa_cavalo ? ` · ${item.placa_cavalo}` : ""}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700">
                    <AlertTriangle className="h-3.5 w-3.5" /> {item.n_erros} {item.n_erros === 1 ? "erro" : "erros"}
                  </span>
                </div>
                <ul className="mt-3 space-y-2">
                  {item.falhas.map((f, i) => (
                    <li key={i} className="rounded-xl border border-border bg-muted/30 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[0.68rem] uppercase tracking-wide text-slate-700">
                          {targetLabel(f.target)}
                        </span>
                        <span className="text-muted-foreground">{f.step}</span>
                      </div>
                      {f.message ? <p className="mt-1 text-sm text-foreground">{f.message}</p> : null}
                      {f.acao ? (
                        <p className="mt-0.5 text-xs text-primary/80">
                          <strong>O que fazer:</strong> {f.acao}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {meta && meta.totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                {meta.totalCount} cadastro{meta.totalCount !== 1 ? "s" : ""} com erro
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
      )}
    </>
  );
}

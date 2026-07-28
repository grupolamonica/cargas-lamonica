import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  deleteProgramacaoRouteColor,
  fetchProgramacaoRouteColors,
  upsertProgramacaoRouteColor,
  type RouteColorRule,
} from "@/services/readModels";
import { COLOR_PRESETS, contrastText, normalizeVehicle } from "@/lib/programacaoColors";

// Compartilhada com a tela Programação: as duas usam ESTA chave, então editar uma cor
// aqui revalida o mapa de cores da lista na hora.
export const PROGRAMACAO_ROUTE_COLORS_KEY = ["operator", "programacao", "route-colors"] as const;

const VEHICLE_SUGGESTIONS = ["TRUCK", "CARRETA", "CARRETA - EXPRESSA"];

const inputCls =
  "rounded-lg border border-border/80 bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/40";

export default function RouteColorsDialog({
  open,
  onOpenChange,
  initialVehicle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill do veículo no formulário (ex.: o veículo da viagem que abriu o painel). */
  initialVehicle?: string;
}) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({
    queryKey: PROGRAMACAO_ROUTE_COLORS_KEY,
    queryFn: fetchProgramacaoRouteColors,
    staleTime: 60_000,
  });

  const [search, setSearch] = useState("");
  const [partida, setPartida] = useState("");
  const [chegada, setChegada] = useState("");
  const [veiculo, setVeiculo] = useState(initialVehicle ? normalizeVehicle(initialVehicle) : "CARRETA");
  const [cor, setCor] = useState(COLOR_PRESETS[0].hex);

  const upsertMut = useMutation({
    mutationFn: upsertProgramacaoRouteColor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROGRAMACAO_ROUTE_COLORS_KEY });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar a cor."),
  });
  const deleteMut = useMutation({
    mutationFn: deleteProgramacaoRouteColor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROGRAMACAO_ROUTE_COLORS_KEY });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao remover a cor."),
  });

  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return rules;
    return rules.filter((r) => `${r.partida} ${r.chegada} ${r.veiculo}`.toUpperCase().includes(q));
  }, [rules, search]);

  const handleAdd = () => {
    const p = partida.trim();
    const c = chegada.trim();
    const v = normalizeVehicle(veiculo);
    if (!p || !c || !v) {
      toast.error("Informe partida, chegada e veículo.");
      return;
    }
    upsertMut.mutate(
      { partida: p, chegada: c, veiculo: v, cor },
      {
        onSuccess: () => {
          toast.success("Cor da rota salva.");
          setPartida("");
          setChegada("");
        },
      },
    );
  };

  // Troca a cor de uma regra existente (upsert com a mesma chave).
  const handleRecolor = (rule: RouteColorRule, nextCor: string) => {
    if (nextCor === rule.cor) return;
    upsertMut.mutate({ partida: rule.partida, chegada: rule.chegada, veiculo: rule.veiculo, cor: nextCor });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Cores da linha por rota</DialogTitle>
          <DialogDescription>
            A viagem é pintada pela cor da rota — código da estação de <strong>partida</strong>,
            código de <strong>chegada</strong> e <strong>veículo</strong>. As cores são compartilhadas
            entre os operadores. Os códigos são os identificadores de estação da Shopee (ex.:{" "}
            <code>8808</code> = Simões Filho, <code>10963</code> = Jaboatão).
          </DialogDescription>
        </DialogHeader>

        {/* Adicionar / editar */}
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border/70 bg-muted/30 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[0.62rem] font-bold uppercase tracking-wide text-muted-foreground">Partida</span>
            <input className={inputCls + " w-24"} value={partida} onChange={(e) => setPartida(e.target.value)} placeholder="8808" inputMode="numeric" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.62rem] font-bold uppercase tracking-wide text-muted-foreground">Chegada</span>
            <input className={inputCls + " w-24"} value={chegada} onChange={(e) => setChegada(e.target.value)} placeholder="10963" inputMode="numeric" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.62rem] font-bold uppercase tracking-wide text-muted-foreground">Veículo</span>
            <input className={inputCls + " w-44"} value={veiculo} onChange={(e) => setVeiculo(e.target.value)} list="route-color-vehicles" placeholder="CARRETA" />
            <datalist id="route-color-vehicles">
              {VEHICLE_SUGGESTIONS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.62rem] font-bold uppercase tracking-wide text-muted-foreground">Cor</span>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={cor}
                onChange={(e) => setCor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-border/80 bg-background p-0.5"
                aria-label="Escolher cor"
              />
              <div className="flex flex-wrap gap-1">
                {COLOR_PRESETS.map((p) => (
                  <button
                    key={p.hex}
                    type="button"
                    title={p.nome}
                    onClick={() => setCor(p.hex)}
                    className="h-5 w-5 rounded border border-border/60"
                    style={{ backgroundColor: p.hex }}
                  />
                ))}
              </div>
            </div>
          </label>
          <Button className="gap-1.5" onClick={handleAdd} disabled={upsertMut.isPending}>
            {upsertMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Adicionar / atualizar
          </Button>
        </div>

        {/* Busca */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className={inputCls + " w-full pl-9"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por código ou veículo…"
          />
        </div>

        {/* Lista */}
        <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-border/70">
          {rulesQuery.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando cores…
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {rules.length === 0 ? "Nenhuma regra de cor cadastrada ainda." : "Nenhuma regra para a busca."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 text-left text-[0.62rem] uppercase tracking-wide text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-3 py-2">Partida</th>
                  <th className="px-3 py-2">Chegada</th>
                  <th className="px-3 py-2">Veículo</th>
                  <th className="px-3 py-2">Cor / Prévia</th>
                  <th className="px-3 py-2 text-right">Remover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 font-mono">{r.partida}</td>
                    <td className="px-3 py-1.5 font-mono">{r.chegada}</td>
                    <td className="px-3 py-1.5">{r.veiculo}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={/^#[0-9a-fA-F]{6}$/.test(r.cor) ? r.cor : "#cccccc"}
                          onChange={(e) => handleRecolor(r, e.target.value)}
                          className="h-6 w-8 cursor-pointer rounded border border-border/80 bg-background p-0.5"
                          aria-label={`Cor da rota ${r.partida} para ${r.chegada}`}
                        />
                        <span
                          className="inline-flex min-w-[92px] justify-center rounded px-2 py-0.5 text-[11px] font-semibold"
                          style={{ backgroundColor: r.cor, color: contrastText(r.cor) }}
                        >
                          exemplo
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => deleteMut.mutate(r.id)}
                        disabled={deleteMut.isPending}
                        className="inline-flex items-center rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title="Remover esta cor"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[0.68rem] text-muted-foreground">
          {rules.length} regra(s) de cor cadastradas.
        </p>
      </DialogContent>
    </Dialog>
  );
}

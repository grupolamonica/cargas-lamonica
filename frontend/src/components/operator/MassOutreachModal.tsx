import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Send, Users } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  enqueueMassOutreach,
  fetchMassRoutes,
  previewMassOutreach,
} from "@/services/readModels";

interface Props {
  open: boolean;
  onClose: () => void;
  onEnqueued: () => void;
}

export default function MassOutreachModal({ open, onClose, onEnqueued }: Props) {
  const [audience, setAudience] = useState<"routes" | "all">("routes");
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [message, setMessage] = useState(
    [
      "{Oi|Olá|E aí|Opa}, {nome}! 👋",
      "",
      "Aqui é a *Lamônica Cargas* 🚚",
      "",
      "{Vi que você já rodou|Lembrei que você já fez|Você já pegou} a rota *{rota}* com a gente. {Agora temos|Apareceu|Abriu} uma carga nesse mesmo trajeto — {quer garantir|topa|bora}?",
      "",
      "{*É só me responder aqui*|*Me responde aqui*|*Responde por aqui*} que eu te passo os detalhes. 🙌",
      "",
      "_Se preferir não receber esse tipo de mensagem, é só me avisar._",
    ].join("\n"),
  );
  const [routeSearch, setRouteSearch] = useState("");

  const { data: routesData, isLoading: loadingRoutes } = useQuery({
    queryKey: ["operator", "mass-outreach", "routes"],
    queryFn: fetchMassRoutes,
    enabled: open,
    staleTime: 60_000,
  });
  const routes = routesData?.items ?? [];
  const filteredRoutes = useMemo(() => {
    const q = routeSearch.trim().toLowerCase();
    if (!q) return routes;
    return routes.filter((r) => r.key.toLowerCase().includes(q));
  }, [routes, routeSearch]);

  const previewMut = useMutation({
    mutationFn: () => previewMassOutreach({ audience, routes: selectedRoutes }),
    onError: (e: Error) => toast.error(e.message || "Erro no preview."),
  });

  const enqueueMut = useMutation({
    mutationFn: () => enqueueMassOutreach({ audience, routes: selectedRoutes, message }),
    onSuccess: (r) => {
      const eta =
        typeof r.etaMinutes === "number" && r.etaMinutes > 0
          ? ` Envio espaçado ao longo de ~${r.etaMinutes >= 60 ? `${Math.round(r.etaMinutes / 60)}h` : `${r.etaMinutes} min`} (anti-bloqueio).`
          : "";
      toast.success(`${r.enqueued} envio(s) enfileirados (de ${r.total} motoristas).${eta}`);
      onEnqueued();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao enfileirar."),
  });

  const toggleRoute = (key: string) =>
    setSelectedRoutes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const audienceReady = audience === "all" || (audience === "routes" && selectedRoutes.length > 0);
  const canSubmit = audienceReady && message.trim().length > 0 && !enqueueMut.isPending;

  const doPreviewAndConfirm = async () => {
    const p = await previewMut.mutateAsync();
    if (!p.total) {
      toast.error("Nenhum motorista casou com o filtro selecionado.");
      return;
    }
    const ok = confirm(
      `Você vai enfileirar ${p.total} envio(s) de WhatsApp.\n` +
        `${p.capped ? "(Limite de segurança de 5000 alcançado — só os primeiros)\n" : ""}` +
        `Os envios respeitam cap diário, quiet hours e opt-out. Continuar?`,
    );
    if (ok) enqueueMut.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl">
        <DialogHeader>
          <DialogTitle>Envio em massa</DialogTitle>
          <DialogDescription>
            Dispare uma mensagem para muitos motoristas de uma vez. Idempotente (não envia duas vezes p/ o mesmo motorista nesta batch); respeita cap diário, opt-out e horários.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Público-alvo */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Público-alvo</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setAudience("routes")}
                className={cn(
                  "admin-soft-panel rounded-2xl border p-3 text-left transition",
                  audience === "routes" ? "border-primary bg-primary/5" : "hover:border-border",
                )}
              >
                <p className="font-medium">Por rota</p>
                <p className="text-xs text-muted-foreground">Motoristas que já carregaram ou se candidataram nessas rotas.</p>
              </button>
              <button
                type="button"
                onClick={() => setAudience("all")}
                className={cn(
                  "admin-soft-panel rounded-2xl border p-3 text-left transition",
                  audience === "all" ? "border-primary bg-primary/5" : "hover:border-border",
                )}
              >
                <p className="font-medium">Todos os motoristas</p>
                <p className="text-xs text-muted-foreground">Todos os motoristas cadastrados com telefone no sistema.</p>
              </button>
            </div>
          </div>

          {/* Lista de rotas (quando audience=routes) */}
          {audience === "routes" ? (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rotas</p>
                <span className="text-[11px] text-muted-foreground">
                  {selectedRoutes.length} selecionada(s)
                </span>
              </div>
              <Input
                value={routeSearch}
                onChange={(e) => setRouteSearch(e.target.value)}
                placeholder="Filtrar rotas por origem ou destino"
                className="mb-2"
              />
              <div className="admin-soft-panel max-h-64 overflow-y-auto rounded-2xl border p-1">
                {loadingRoutes && !routes.length ? (
                  <p className="p-3 text-sm text-muted-foreground">Carregando rotas…</p>
                ) : filteredRoutes.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">Nenhuma rota encontrada.</p>
                ) : (
                  <ul className="divide-y divide-border/40">
                    {filteredRoutes.map((r) => (
                      <li key={r.key}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted/40">
                          <Checkbox
                            checked={selectedRoutes.includes(r.key)}
                            onCheckedChange={() => toggleRoute(r.key)}
                          />
                          <span className="flex-1 truncate">
                            {r.origem} → {r.destino}
                          </span>
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            {r.driverCount} motorista(s)
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {selectedRoutes.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selectedRoutes.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleRoute(k)}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                    >
                      {k} ×
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSelectedRoutes([])}
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    limpar
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Mensagem */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mensagem</p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Placeholders: <code className="rounded bg-muted px-1">{"{nome}"}</code> (primeiro nome) ·{" "}
              <code className="rounded bg-muted px-1">{"{rota}"}</code> (origem → destino, quando aplicável)
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              💡 Variações: <code className="rounded bg-muted px-1">{"{Oi|Olá|E aí}"}</code> — cada
              motorista recebe uma opção sorteada. Evita mensagens idênticas em massa (reduz risco de
              bloqueio no WhatsApp).
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              🛡️ Envio protegido: as mensagens saem <strong>espaçadas</strong> (uma a cada ~1–2 min,
              com “digitando…”), respeitando limite por hora e por dia — não dispara tudo de uma vez.
            </p>
          </div>

          {/* Preview + ação */}
          {previewMut.data ? (
            <div className="admin-soft-panel rounded-2xl border p-3 text-xs">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <Users className="h-3.5 w-3.5" /> Preview do público
              </p>
              <p className="text-muted-foreground">
                Total: <span className="font-semibold text-foreground">{previewMut.data.total}</span> motorista(s)
                {previewMut.data.capped ? " (limite 5000 atingido)" : ""}.
              </p>
              {previewMut.data.sample.length ? (
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {previewMut.data.sample.map((s, i) => (
                    <li key={i}>
                      • {s.nome || s.cpf || "(sem nome)"} — {s.phone}
                      {s.rota ? ` · ${s.rota}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button
              variant="secondary"
              onClick={() => previewMut.mutate()}
              disabled={!audienceReady || previewMut.isPending}
              className="gap-1.5"
            >
              {previewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
              Prever público
            </Button>
            <Button onClick={doPreviewAndConfirm} disabled={!canSubmit} className="gap-1.5">
              {enqueueMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Enfileirar envio
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

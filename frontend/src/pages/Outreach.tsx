import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MessageCircle,
  Play,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  Send,
  Smartphone,
  Snowflake,
  Trash2,
  Truck,
  XCircle,
} from "lucide-react";

import DashboardHeader from "@/components/DashboardHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { friendlyOutreachError } from "@/lib/outreach-errors";
import ChatPanel from "@/components/operator/ChatPanel";
import MassOutreachModal from "@/components/operator/MassOutreachModal";
import { MessageTemplatesPanel } from "@/components/operator/MessageTemplatesPanel";
import {
  addOutreachOptout,
  cancelOutreachQueued,
  connectWhatsapp,
  createOutreachManual,
  disconnectWhatsapp,
  fetchOutreachOverview,
  fetchOutreachQueueItem,
  fetchWhatsappStatus,
  reconcileRegistrations,
  removeOutreachOptout,
  revalidateOutreachQueue,
  runOutreachScan,
  sendOutreachQueueItem,
  sendWhatsappTest,
  updateOutreachQueueItem,
  updateOutreachSettings,
  type DriverOpportunity,
  type OutreachSettings,
} from "@/services/readModels";

const OVERVIEW_KEY = ["operator", "outreach", "overview"];
const WHATSAPP_KEY = ["operator", "outreach", "whatsapp"];

const TRIGGER_LABELS: Record<string, string> = {
  churn: "Recuperação",
  lost_registration: "Cadastro não finalizado",
  abandonment: "Abandono",
  return_load: "Carga de retorno",
  preferences: "Preferências",
};

const STATUS_TINT: Record<string, string> = {
  pending: "border-amber-200 bg-amber-50/80 text-amber-800",
  sent: "border-emerald-200 bg-emerald-50/80 text-emerald-700",
  failed: "border-red-200 bg-red-50/80 text-red-700",
  skipped: "border-slate-200 bg-slate-50/80 text-slate-600",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  sent: "Enviado",
  failed: "Falhou",
  skipped: "Pulado",
};

const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

/** Filtro multiselect (Popover + checkboxes). Vazio = "Todos" (sem filtro). */
function MultiSelect({
  options,
  selected,
  onChange,
  allLabel = "Todos",
  width = "w-44",
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  width?: string;
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const chosen = options.filter((o) => selected.includes(o.value));
  const summary =
    selected.length === 0 || selected.length === options.length
      ? allLabel
      : chosen.length <= 2
      ? chosen.map((o) => o.label).join(", ")
      : `${selected.length} selecionados`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9 justify-between gap-2 font-normal", width)}>
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="space-y-0.5">
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {selected.length ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs font-medium text-primary hover:bg-muted"
            >
              Limpar seleção
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const STATUS_FILTER_OPTIONS = [
  { value: "pending", label: "Pendente" },
  { value: "sent", label: "Enviado" },
  { value: "failed", label: "Falhou" },
  { value: "skipped", label: "Pulado" },
];
const TRIGGER_FILTER_OPTIONS = [
  { value: "churn", label: "Recuperação" },
  { value: "lost_registration", label: "Cadastro não finalizado" },
  { value: "abandonment", label: "Abandono" },
  { value: "return_load", label: "Carga de retorno" },
];
// Padrão da Fila: mostra tudo menos "Pulado".
const DEFAULT_STATUS_SEL = ["pending", "sent", "failed"];

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDateBR(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
        disabled && "opacity-50",
      )}
    >
      <span className={cn("inline-block h-5 w-5 transform rounded-full bg-white shadow transition", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

function Section({
  title,
  children,
  right,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = collapsible ? open : true;
  return (
    <section className="admin-card-surface rounded-[20px] border p-5">
      <div className={cn("flex items-center justify-between gap-3", showBody && "mb-4")}>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 items-center gap-2 text-left"
            title={open ? "Minimizar" : "Expandir"}
          >
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">{title}</h2>
          </button>
        ) : (
          <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">{title}</h2>
        )}
        {right}
      </div>
      {showBody ? children : null}
    </section>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="admin-card-surface rounded-[20px] border px-4 py-3">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone || "text-foreground")}>{value}</p>
    </div>
  );
}

/* ─── Conexão do WhatsApp ─────────────────────────────────────────────── */

function whatsappBadge(state: string) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode; pulse?: boolean }> = {
    open: { label: "Conectado", cls: "border-emerald-200 bg-emerald-50/80 text-emerald-700", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    connecting: { label: "Aguardando leitura do QR", cls: "border-amber-200 bg-amber-50/80 text-amber-800", icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, pulse: true },
    close: { label: "Desconectado", cls: "border-amber-200 bg-amber-50/80 text-amber-800", icon: <Power className="h-3.5 w-3.5" /> },
    not_created: { label: "Sem número conectado", cls: "border-slate-200 bg-slate-50/80 text-slate-600", icon: <Power className="h-3.5 w-3.5" /> },
    not_configured: { label: "Gateway não configurado", cls: "border-slate-200 bg-slate-50/80 text-slate-600", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
    error: { label: "Erro na conexão", cls: "border-red-200 bg-red-50/80 text-red-700", icon: <XCircle className="h-3.5 w-3.5" /> },
  };
  const b = map[state] || { label: state, cls: "border-slate-200 bg-slate-50/80 text-slate-600", icon: <AlertTriangle className="h-3.5 w-3.5" /> };
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold", b.cls, b.pulse && "animate-pulse")}>
      {b.icon}
      {b.label}
    </span>
  );
}

function formatPairing(code: string) {
  const c = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function WhatsappCard() {
  const queryClient = useQueryClient();
  const [qrOpen, setQrOpen] = useState(false);
  const [mode, setMode] = useState<"qr" | "code">("qr");
  const [qr, setQr] = useState<{ qrBase64: string | null; error?: boolean } | null>(null);
  const [pairing, setPairing] = useState<{ code: string | null; error?: boolean } | null>(null);
  const [connectNumber, setConnectNumber] = useState("");
  const [testPhone, setTestPhone] = useState("");

  const { data: status } = useQuery({
    queryKey: WHATSAPP_KEY,
    queryFn: fetchWhatsappStatus,
    refetchInterval: qrOpen ? 3_000 : 12_000,
  });

  const state = status?.state ?? "not_configured";
  const connected = state === "open";
  const configured = status?.configured ?? false;

  // Fecha o modal automaticamente quando conectar.
  useEffect(() => {
    if (qrOpen && connected) {
      setQrOpen(false);
      setQr(null);
      setPairing(null);
      toast.success("WhatsApp conectado!");
    }
  }, [connected, qrOpen]);

  const connectMut = useMutation({
    mutationFn: (input?: { number?: string }) => connectWhatsapp(input),
    onSuccess: (r) => {
      if (r.state === "open") {
        toast.success("WhatsApp já está conectado.");
        queryClient.invalidateQueries({ queryKey: WHATSAPP_KEY });
        return;
      }
      if (r.mode === "code") {
        if (r.pairingCode) setPairing({ code: r.pairingCode });
        else { setPairing({ code: null, error: true }); toast.error("Não foi possível gerar o código."); }
        return;
      }
      if (r.qrBase64) { setQr({ qrBase64: r.qrBase64, error: false }); return; }
      // Gateway não devolveu o QR (Baileys sem handshake / versão do Evolution).
      setQr({ qrBase64: null, error: true });
      toast.error("O gateway não gerou o QR Code.");
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao conectar."),
  });
  const disconnectMut = useMutation({
    mutationFn: disconnectWhatsapp,
    onSuccess: () => { toast.success("Número desconectado."); queryClient.invalidateQueries({ queryKey: WHATSAPP_KEY }); },
    onError: (e: Error) => toast.error(e.message || "Erro ao desconectar."),
  });
  const testMut = useMutation({
    mutationFn: sendWhatsappTest,
    onSuccess: () => toast.success("Mensagem de teste enviada."),
    onError: (e: Error) => toast.error(e.message || "Erro ao enviar teste."),
  });

  // Abre o modal em modo QR e já dispara a geração do QR.
  const openConnect = () => {
    setMode("qr");
    setQr(null);
    setPairing(null);
    setQrOpen(true);
    connectMut.mutate(undefined);
  };
  // Gera o código de pareamento (sem câmera) para o número informado.
  const generateCode = () => {
    if (connectNumber.replace(/\D/g, "").length < 10) { toast.error("Digite o número com DDD."); return; }
    setPairing(null);
    connectMut.mutate({ number: connectNumber });
  };

  const qrSrc = qr?.qrBase64 ? (qr.qrBase64.startsWith("data:") ? qr.qrBase64 : `data:image/png;base64,${qr.qrBase64}`) : null;

  return (
    <Section title="Conexão do WhatsApp" right={whatsappBadge(state)} collapsible defaultOpen={false}>
      {!configured ? (
        <p className="text-sm text-muted-foreground">
          O gateway (Evolution) ainda não está configurado neste ambiente. Enquanto isso, o envio manual pelo modal do
          motorista continua funcionando. Para habilitar o envio automático, configure o gateway e conecte um número aqui.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {connected
              ? "Um número está conectado e pronto para enviar. Você pode trocar o número ou validar com um envio de teste."
              : "Nenhum número conectado. Clique em conectar e escaneie o QR Code no WhatsApp do número que fará os envios."}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={openConnect} disabled={connectMut.isPending} className="gap-2">
              {connectMut.isPending && mode === "qr" ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              {connected ? "Trocar número" : "Conectar número"}
            </Button>
            {connected ? (
              <Button variant="outline" onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending} className="gap-2 text-red-600 hover:text-red-700">
                {disconnectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />} Desconectar
              </Button>
            ) : null}
          </div>

          {/* Validar envio */}
          <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium"><Smartphone className="h-4 w-4 text-primary" /> Validar envio</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Telefone de teste (com DDD)</span>
                <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="(71) 99999-9999" className="w-56" />
              </label>
              <Button
                variant="secondary"
                className="gap-2"
                disabled={!connected || testPhone.replace(/\D/g, "").length < 10 || testMut.isPending}
                onClick={() => testMut.mutate({ phone: testPhone })}
              >
                {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar teste
              </Button>
            </div>
            {!connected ? <p className="mt-2 text-xs text-muted-foreground">Conecte um número para validar o envio.</p> : null}
          </div>
        </div>
      )}

      {/* Modal de conexão (QR ou código sem câmera) */}
      <Dialog open={qrOpen} onOpenChange={(o) => { if (!o) { setQrOpen(false); setQr(null); setPairing(null); } }}>
        <DialogContent className="max-w-sm overflow-hidden rounded-3xl">
          <DialogHeader>
            <DialogTitle>Conectar WhatsApp</DialogTitle>
            <DialogDescription>Escolha como conectar o número que fará os envios.</DialogDescription>
          </DialogHeader>

          {/* Seletor de modo */}
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            <button
              type="button"
              onClick={() => { setMode("qr"); if (!qrSrc && !connectMut.isPending) connectMut.mutate(undefined); }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                mode === "qr" ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <QrCode className="h-3.5 w-3.5" /> QR Code
            </button>
            <button
              type="button"
              onClick={() => setMode("code")}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                mode === "code" ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Smartphone className="h-3.5 w-3.5" /> Código (sem câmera)
            </button>
          </div>

          {mode === "qr" ? (
            <div className="flex w-full flex-col items-center gap-3 pb-1">
              <p className="text-center text-xs text-muted-foreground">
                No celular: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> → aponte para o QR.
              </p>
              {qrSrc ? (
                <img src={qrSrc} alt="QR Code do WhatsApp" className="h-60 w-60 max-w-full rounded-xl border border-border" />
              ) : qr?.error ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <AlertTriangle className="h-8 w-8 text-amber-500" />
                  <p className="text-sm font-medium text-foreground">Não foi possível gerar o QR Code</p>
                  <p className="text-xs text-muted-foreground">Tente o modo “Código (sem câmera)” ao lado.</p>
                </div>
              ) : (
                <div className="flex h-60 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
              )}
              {qrSrc ? (
                <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Aguardando leitura…</p>
              ) : null}
            </div>
          ) : (
            <div className="flex w-full flex-col gap-3 pb-1">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Número do WhatsApp (com DDD)</span>
                <Input value={connectNumber} onChange={(e) => setConnectNumber(e.target.value)} placeholder="(71) 99999-9999" />
              </label>
              <Button onClick={generateCode} disabled={connectMut.isPending} className="gap-2">
                {connectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />} Gerar código
              </Button>

              {pairing?.code ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-center">
                  <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Seu código de pareamento
                  </p>
                  <p className="my-2 select-all font-mono text-3xl font-bold tracking-[0.25em] text-emerald-800">{formatPairing(pairing.code)}</p>
                  <ol className="mt-3 space-y-1 text-left text-xs text-muted-foreground">
                    <li>1. No WhatsApp do número: <b>Aparelhos conectados</b></li>
                    <li>2. <b>Conectar um aparelho</b></li>
                    <li>3. Toque em <b>Conectar com número de telefone</b></li>
                    <li>4. Digite o código acima</li>
                  </ol>
                </div>
              ) : pairing?.error ? (
                <p className="text-center text-xs text-red-600">Não foi possível gerar o código. Tente novamente.</p>
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  Digite o número e clique em “Gerar código”. Você recebe um código de 8 caracteres para digitar no WhatsApp — sem escanear nada.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/* ─── Detalhe / edição de um item da fila ─────────────────────────────── */

const SENDABLE_TRIGGER_OPTIONS: { value: string; label: string }[] = [
  { value: "churn", label: "Recuperação (churn)" },
  { value: "lost_registration", label: "Cadastro não finalizado" },
  { value: "abandonment", label: "Abandono" },
  { value: "return_load", label: "Carga de retorno" },
];

function waMeUrl(phone: string, text: string) {
  const d = phone.replace(/\D/g, "");
  const digits = d.startsWith("55") ? d : d.length >= 10 ? `55${d}` : "";
  if (!digits || !text.trim()) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Contexto do gatilho selecionado: dados que faltam / sinais / sugestões. */
function QueueContext({ trigger, opportunities }: { trigger: string; opportunities: DriverOpportunity[] }) {
  const opp = opportunities.find((o) => o.trigger === trigger);
  if (!opp) {
    return <p className="text-xs text-muted-foreground">Nada detectado para este gatilho agora — o texto é o padrão.</p>;
  }
  const d = opp.data as Record<string, unknown>;

  if (trigger === "lost_registration") {
    const missing = (d.missingSteps ?? []) as { key: string; label: string }[];
    const done = (d.completedSteps ?? []) as { key: string; label: string }[];
    return (
      <div className="space-y-2.5">
        <p className="text-sm text-foreground">{opp.reason}</p>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Falta enviar</p>
          <ul className="space-y-1">
            {missing.map((s) => (
              <li key={s.key} className="flex items-start gap-2 text-sm text-foreground">
                <Circle className="mt-1 h-3 w-3 shrink-0 text-amber-500" /> {s.label}
              </li>
            ))}
          </ul>
        </div>
        {done.length ? (
          <p className="text-xs text-muted-foreground">✓ Já enviou: {done.map((s) => s.label).join("; ")}</p>
        ) : null}
      </div>
    );
  }

  if (trigger === "abandonment") {
    const signals = (d.signals ?? []) as { kind: string; label?: string; ageHours?: number }[];
    return (
      <div className="space-y-2">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Tipos de abandono
        </p>
        <ul className="space-y-1">
          {signals.map((s, i) => (
            <li key={`${s.kind}-${i}`} className="flex items-start gap-2 text-sm text-foreground">
              <Circle className="mt-1 h-3 w-3 shrink-0 text-amber-500" />
              <span>{s.label ?? s.kind}{typeof s.ageHours === "number" ? <span className="text-muted-foreground"> — há {s.ageHours}h</span> : null}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (trigger === "return_load") {
    const suggestions = (d.suggestions ?? []) as { origem: string; destino: string; dateIso: string | null; backToBase?: boolean }[];
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground">{opp.reason}</p>
        <ul className="space-y-1.5">
          {suggestions.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-foreground">
              <Truck className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span>{s.origem} → {s.destino}{s.backToBase ? <span className="ml-1 text-[10px] font-semibold text-emerald-600">volta à base</span> : null}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return <p className="text-sm text-foreground">{opp.reason}</p>;
}

function QueueItemModal({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["operator", "outreach", "queue-item", id],
    queryFn: () => fetchOutreachQueueItem(id as string),
    enabled: Boolean(id),
  });
  const { data: waStatus } = useQuery({ queryKey: WHATSAPP_KEY, queryFn: fetchWhatsappStatus, staleTime: 10_000 });
  const connected = waStatus?.state === "open";

  const [trigger, setTrigger] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  const item = data?.item;
  useEffect(() => {
    if (item) {
      setTrigger(item.trigger);
      setPhone(item.phone);
      setMessage(item.message);
    }
    // Reinicializa quando um item diferente carrega (ou volta do refetch pós-save).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.trigger, item?.phone, item?.message]);

  const editable = item?.status === "pending";
  const dirty = Boolean(
    item &&
      (trigger !== item.trigger ||
        phone.replace(/\D/g, "") !== item.phone.replace(/\D/g, "") ||
        message !== item.message),
  );

  const changeTrigger = (t: string) => {
    setTrigger(t);
    const suggested = data?.messagesByTrigger?.[t];
    if (suggested) setMessage(suggested);
  };

  const refreshItem = () => {
    queryClient.invalidateQueries({ queryKey: ["operator", "outreach", "queue-item", id] });
    onChanged();
  };

  const saveMut = useMutation({
    mutationFn: () => updateOutreachQueueItem(id as string, { trigger, phone, message }),
    onSuccess: () => { toast.success("Alterações salvas."); refreshItem(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar."),
  });
  const sendMut = useMutation({
    mutationFn: async () => {
      if (dirty) await updateOutreachQueueItem(id as string, { trigger, phone, message });
      return sendOutreachQueueItem(id as string);
    },
    onSuccess: () => { toast.success("Mensagem enviada."); onChanged(); onClose(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao enviar."),
  });
  const cancelMut = useMutation({
    mutationFn: () => cancelOutreachQueued(id as string),
    onSuccess: () => { toast.success("Envio cancelado."); onChanged(); onClose(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao cancelar."),
  });

  const wa = waMeUrl(phone, message);

  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl">
        <DialogHeader>
          <DialogTitle>Detalhe do envio</DialogTitle>
          <DialogDescription>Revise, ajuste o motivo/mensagem e escolha para quem enviar.</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError || !item ? (
          <p className="py-6 text-center text-sm text-destructive">Não foi possível carregar o item.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Motorista</p>
                <p className="truncate text-sm font-medium text-foreground">{data.driver?.nome || item.driverKey}</p>
                {data.driver?.cpf && data.driver?.nome ? (
                  <p className="font-mono text-[11px] text-muted-foreground">CPF {data.driver.cpf}</p>
                ) : null}
              </div>
              <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", STATUS_TINT[item.status] ?? "")}>
                {statusLabel(item.status)}{item.retryCount ? ` (${item.retryCount})` : ""}
              </span>
            </div>

            {data.optedOut ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs font-medium text-amber-800">
                Motorista está na lista de opt-out (não perturbe) — envio automático bloqueado.
              </p>
            ) : null}

            {data.angellira?.vigente ? (
              <div className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700">
                <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> Já cadastrado no Angellira</p>
                <p className="mt-0.5">
                  Cadastro <b>vigente até {fmtDateBR(data.angellira.validUntil)}</b>
                  {data.angellira.name ? ` (${data.angellira.name})` : ""}. Provavelmente não precisa deste contato — o envio está bloqueado.
                </p>
              </div>
            ) : data.angellira?.checked && data.angellira?.found && !data.angellira?.vigente ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
                No Angellira, o cadastro consta <b>vencido em {fmtDateBR(data.angellira.validUntil)}</b> — contato de renovação é válido.
              </p>
            ) : data.angellira?.checked && !data.angellira?.found ? (
              <p className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700">
                Não encontrado no Angellira — contato de cadastro é válido.
              </p>
            ) : null}

            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Motivo / gatilho</span>
              <select
                value={trigger}
                disabled={!editable}
                onChange={(e) => changeTrigger(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
              >
                {SENDABLE_TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {editable ? <span className="mt-1 block text-[11px] text-muted-foreground">Trocar o motivo atualiza o texto sugerido da mensagem.</span> : null}
            </label>

            <div className="admin-soft-panel px-4 py-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Motivo detectado / dados que faltam</p>
              <QueueContext trigger={trigger} opportunities={data.opportunities} />
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Para quem enviar (telefone com DDD)</span>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!editable} placeholder="(71) 99999-9999" />
              {data.phoneCandidates.length > 1 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.phoneCandidates.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={!editable}
                      onClick={() => setPhone(p)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                        phone.replace(/\D/g, "") === p.replace(/\D/g, "") ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Mensagem que será enviada</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!editable}
                rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed disabled:opacity-60"
              />
              <p className="mt-1 text-right text-[11px] text-muted-foreground">{message.length} caracteres</p>
            </div>

            {item.lastError ? (
              <p
                className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-700"
                title={item.lastError}
              >
                Último erro: {friendlyOutreachError(item.lastError)}
              </p>
            ) : null}

            {editable ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="outline" className="gap-1.5 text-red-600 hover:text-red-700" onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}>
                    <Trash2 className="h-4 w-4" /> Cancelar envio
                  </Button>
                  {wa ? (
                    <Button variant="outline" className="gap-1.5" onClick={() => window.open(wa, "_blank", "noopener,noreferrer")}>
                      <MessageCircle className="h-4 w-4" /> Abrir no WhatsApp
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending} className="gap-1.5">
                    {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Salvar
                  </Button>
                  <Button onClick={() => sendMut.mutate()} disabled={sendMut.isPending || !connected || data.optedOut || Boolean(data.angellira?.vigente)} className="gap-1.5">
                    {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar agora
                  </Button>
                </div>
                {data.angellira?.vigente ? (
                  <p className="text-right text-[11px] text-red-600">“Enviar agora” bloqueado: motorista já cadastrado no Angellira.</p>
                ) : !connected ? (
                  <p className="text-right text-[11px] text-muted-foreground">Conecte o WhatsApp para “Enviar agora”. Você também pode usar “Abrir no WhatsApp” (manual).</p>
                ) : null}
              </div>
            ) : (
              <p className="text-center text-xs text-muted-foreground">Este item está “{statusLabel(item.status)}” — não pode mais ser editado.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Inserção manual na fila ─────────────────────────────────────────── */

function ManualInsertModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");
  const [trigger, setTrigger] = useState("lost_registration");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (open) { setNome(""); setCpf(""); setPhone(""); setTrigger("lost_registration"); setMessage(""); }
  }, [open]);

  const createMut = useMutation({
    mutationFn: () =>
      createOutreachManual({
        cpf: cpf.trim() || undefined,
        nome: nome.trim() || undefined,
        phone,
        trigger,
        message: message.trim() || undefined,
      }),
    onSuccess: () => { toast.success("Item adicionado à fila."); onCreated(); onClose(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao inserir."),
  });

  const canSubmit = phone.replace(/\D/g, "").length >= 10 && Boolean(cpf.trim() || nome.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md rounded-3xl">
        <DialogHeader>
          <DialogTitle>Inserir na fila manualmente</DialogTitle>
          <DialogDescription>Adicione um envio para um motorista específico.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Nome</span>
              <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do motorista" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">CPF</span>
              <Input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Telefone (com DDD)</span>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(71) 99999-9999" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Motivo / gatilho</span>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {SENDABLE_TRIGGER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Mensagem (opcional)</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Deixe vazio para usar o texto padrão do gatilho."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
            />
          </label>
          <p className="text-[11px] text-muted-foreground">Informe CPF ou nome + telefone. Idempotente: não duplica o mesmo motorista/gatilho.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button onClick={() => createMut.mutate()} disabled={!canSubmit || createMut.isPending} className="gap-1.5">
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Adicionar à fila
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Página ──────────────────────────────────────────────────────────── */

export default function Outreach() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: fetchOutreachOverview,
    refetchInterval: 15_000,
  });

  const [form, setForm] = useState<OutreachSettings | null>(null);
  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data?.settings]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });

  const saveMut = useMutation({
    mutationFn: (patch: Partial<OutreachSettings>) => updateOutreachSettings(patch),
    onSuccess: () => { toast.success("Configuração salva."); invalidate(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar."),
  });
  const scanMut = useMutation({
    mutationFn: runOutreachScan,
    onSuccess: (r) => { toast.success(`Varredura concluída — ${r.enqueued} enfileirada(s).`); invalidate(); },
    onError: (e: Error) => toast.error(e.message || "Erro na varredura."),
  });
  const optoutAddMut = useMutation({
    mutationFn: addOutreachOptout,
    onSuccess: () => { toast.success("Opt-out adicionado."); invalidate(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao adicionar."),
  });
  const optoutRemoveMut = useMutation({
    mutationFn: removeOutreachOptout,
    onSuccess: () => { toast.success("Opt-out removido."); invalidate(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao remover."),
  });
  const cancelMut = useMutation({
    mutationFn: cancelOutreachQueued,
    onSuccess: () => { toast.success("Envio cancelado."); invalidate(); },
    onError: (e: Error) => toast.error(e.message || "Erro ao cancelar."),
  });

  const [optCpf, setOptCpf] = useState("");
  const [optReason, setOptReason] = useState("");
  const [queueDetailId, setQueueDetailId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [massOpen, setMassOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "automacao">("chat");
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);

  // Filtros da Fila (multiselect). Padrão: oculta "Pulados".
  const [statusSel, setStatusSel] = useState<string[]>(DEFAULT_STATUS_SEL);
  const [triggerSel, setTriggerSel] = useState<string[]>([]);
  const [fDriver, setFDriver] = useState("");
  const [fFrom, setFFrom] = useState("");

  const revalidateMut = useMutation({
    mutationFn: revalidateOutreachQueue,
    onSuccess: (r) => {
      toast.success(`Revalidação Angellira: ${r.cancelled} cancelado(s) (já cadastrados), ${r.kept} mantido(s).`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao revalidar."),
  });
  const reconcileMut = useMutation({
    mutationFn: reconcileRegistrations,
    onSuccess: (r) => {
      if (r.alreadyRunning) {
        toast.info("Conciliação já está rodando — aguarde o aviso no sino.");
      } else if (!r.started) {
        toast.info("Nenhum cadastro pendente para conciliar.");
      } else {
        toast.success(
          `Conciliação iniciada para ${r.candidates} cadastro(s). Roda em segundo plano (o Angellira é lento) — você recebe o resultado no sino de notificações. 🔔`,
        );
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao conciliar cadastros."),
  });

  if (isLoading || !form) {
    return (
      <div className="min-w-0">
        <DashboardHeader title="Mensagens automáticas" subtitle="Envio de WhatsApp para motoristas" />
        <main className="p-6 lg:p-8">
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
        </main>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="min-w-0">
        <DashboardHeader title="Mensagens automáticas" subtitle="Envio de WhatsApp para motoristas" />
        <main className="p-6 lg:p-8"><p className="text-destructive">Não foi possível carregar o painel.</p></main>
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const { queueStats, sentLast24h } = data;

  const driverQuery = fDriver.trim().toLowerCase();
  const filteredQueue = data.queue.filter((q) => {
    if (statusSel.length && !statusSel.includes(q.status)) return false;
    if (triggerSel.length && !triggerSel.includes(q.trigger)) return false;
    if (driverQuery && !`${q.driver_name || ""} ${q.driver_key}`.toLowerCase().includes(driverQuery)) return false;
    if (fFrom) {
      const day = (q.sent_at || q.created_at || "").slice(0, 10);
      if (day && day < fFrom) return false;
    }
    return true;
  });
  const statusIsDefault =
    statusSel.length === DEFAULT_STATUS_SEL.length && DEFAULT_STATUS_SEL.every((s) => statusSel.includes(s));
  const filtersActive = !statusIsDefault || triggerSel.length > 0 || Boolean(driverQuery) || Boolean(fFrom);
  const clearFilters = () => { setStatusSel(DEFAULT_STATUS_SEL); setTriggerSel([]); setFDriver(""); setFFrom(""); };

  return (
    <div className="min-w-0">
      <DashboardHeader
        title="Mensagens"
        subtitle={
          activeTab === "chat"
            ? "Conversas do WhatsApp com os motoristas"
            : "Recuperação, cadastro, abandono e carga de retorno — envio automático"
        }
        actions={
          activeTab === "automacao" ? (
            <Button variant="outline" className="gap-2" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
              {scanMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Rodar varredura
            </Button>
          ) : null
        }
      />

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        {/* Abas */}
        <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
          <button
            type="button"
            onClick={() => setActiveTab("chat")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              activeTab === "chat" ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Chat com motoristas
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("automacao")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              activeTab === "automacao" ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Automação
          </button>
        </div>

        {activeTab === "chat" ? <ChatPanel /> : null}
        {activeTab === "automacao" ? <WhatsappCard /> : null}

        {activeTab === "automacao" ? (
          <>
        {/* Configuração */}
        <Section title="Configuração" collapsible defaultOpen={false}>
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">Envio automático</p>
                <p className="text-sm text-muted-foreground">Liga/desliga o disparo automático. Desligado: nada é enviado (o operador ainda envia manual pelo modal do motorista).</p>
              </div>
              <Toggle
                checked={form.enabled}
                onChange={(v) => {
                  // Ligar exige confirmação explícita (passa a disparar WhatsApp);
                  // desligar é a direção segura e aplica na hora.
                  if (v) setConfirmEnableOpen(true);
                  else setForm({ ...form, enabled: false });
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-1.5 font-medium"><Snowflake className="h-4 w-4 text-sky-500" /> Incluir gatilhos frios</p>
                <p className="text-sm text-muted-foreground">Recuperação (churn) e carga de retorno = contato não solicitado. Maior risco de bloqueio do número. Comece desligado.</p>
              </div>
              <Toggle checked={form.coldEnabled} onChange={(v) => setForm({ ...form, coldEnabled: v })} disabled={!form.enabled} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Limite por dia</span>
                <Input type="number" min={0} max={1000} value={form.dailyCap} onChange={(e) => setForm({ ...form, dailyCap: Number(e.target.value) })} className="tabular-nums" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Enviar a partir de (h)</span>
                <Input type="number" min={0} max={23} value={form.quietStartHour} onChange={(e) => setForm({ ...form, quietStartHour: Number(e.target.value) })} className="tabular-nums" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Parar de enviar às (h)</span>
                <Input type="number" min={0} max={24} value={form.quietEndHour} onChange={(e) => setForm({ ...form, quietEndHour: Number(e.target.value) })} className="tabular-nums" />
              </label>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
              <div>
                <p className="flex items-center gap-1.5 font-medium">🚚 Chamar motorista para carga sem candidato</p>
                <p className="text-sm text-muted-foreground">
                  Quando uma carga está sem candidatura e o carregamento se aproxima, o sistema chama automaticamente motoristas que já fizeram a rota e não estão em viagem (em ondas de {form.routeNeedWaveSize ?? 5}). Ao aceitar, pergunta o melhor dia/horário e oferece a carga mais próxima.
                </p>
              </div>
              <Toggle
                checked={Boolean(form.routeNeedEnabled)}
                onChange={(v) => setForm({ ...form, routeNeedEnabled: v })}
                disabled={!form.enabled}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Só cargas que carregam nos próximos (dias)</span>
                <Input
                  type="number"
                  min={0}
                  max={60}
                  value={form.routeNeedDaysAhead ?? 3}
                  onChange={(e) => setForm({ ...form, routeNeedDaysAhead: Number(e.target.value) })}
                  className="tabular-nums"
                  disabled={!form.routeNeedEnabled}
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Motoristas por onda</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={form.routeNeedWaveSize ?? 5}
                  onChange={(e) => setForm({ ...form, routeNeedWaveSize: Number(e.target.value) })}
                  className="tabular-nums"
                  disabled={!form.routeNeedEnabled}
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {data.settings.updatedAt ? `Última alteração: ${fmtDateTime(data.settings.updatedAt)}` : "Configuração padrão"} · janela {form.quietStartHour}h–{form.quietEndHour}h BRT
              </p>
              <Button onClick={() => saveMut.mutate(form)} disabled={!dirty || saveMut.isPending} className="gap-2">
                {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Salvar
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
              <div className="min-w-0">
                <p className="font-medium">Conciliar cadastros com o Angellira</p>
                <p className="text-sm text-muted-foreground">
                  Marca como concluído os cadastros em “pendente/rascunho” de quem já está vigente no Angellira — some de “cadastro não finalizado” em todo o sistema.
                </p>
              </div>
              <Button
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => reconcileMut.mutate()}
                disabled={reconcileMut.isPending}
              >
                {reconcileMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Conciliar
              </Button>
            </div>
          </div>
        </Section>

        {/* Central de mensagens automáticas */}
        <Section title="Mensagens">
          <MessageTemplatesPanel />
        </Section>

        {/* Estatísticas */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Na fila" value={queueStats.pending} tone="text-amber-600" />
          <StatCard label="Enviados 24h" value={`${sentLast24h}/${form.dailyCap}`} tone="text-emerald-600" />
          <StatCard label="Enviados (total)" value={queueStats.sent} />
          <StatCard label="Falhas" value={queueStats.failed} tone={queueStats.failed ? "text-red-600" : "text-foreground"} />
          <StatCard label="Pulados" value={queueStats.skipped} />
        </div>

        {/* Fila */}
        <Section
          title="Fila de envio"
          collapsible
          defaultOpen={false}
          right={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => revalidateMut.mutate()}
                disabled={revalidateMut.isPending || !data.queue.length}
                title="Cancela os itens de cadastro cujo motorista já está vigente no Angellira"
              >
                {revalidateMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Revalidar (Angellira)
              </Button>
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setManualOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Inserir manualmente
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => setMassOpen(true)}>
                <Send className="h-3.5 w-3.5" /> Envio em massa
              </Button>
            </div>
          }
        >
          {data.queue.length > 0 ? (
            <div className="mb-4 flex flex-wrap items-end gap-2">
              <div className="text-xs">
                <span className="mb-1 block font-medium text-muted-foreground">Status</span>
                <MultiSelect options={STATUS_FILTER_OPTIONS} selected={statusSel} onChange={setStatusSel} width="w-48" />
              </div>
              <div className="text-xs">
                <span className="mb-1 block font-medium text-muted-foreground">Gatilho</span>
                <MultiSelect options={TRIGGER_FILTER_OPTIONS} selected={triggerSel} onChange={setTriggerSel} width="w-52" />
              </div>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-muted-foreground">Motorista</span>
                <Input value={fDriver} onChange={(e) => setFDriver(e.target.value)} placeholder="CPF ou nome" className="h-9 w-40" />
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-muted-foreground">Enviado a partir de</span>
                <Input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} className="h-9 w-40" />
              </label>
              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9">Limpar filtros</Button>
              ) : null}
              <span className="ml-auto self-center text-[11px] text-muted-foreground">
                {filteredQueue.length} de {data.queue.length} · clique numa linha para detalhes
              </span>
            </div>
          ) : null}

          {data.queue.length === 0 ? (
            <p className="text-sm text-muted-foreground">Fila vazia. Use “Rodar varredura” para detectar e enfileirar oportunidades.</p>
          ) : filteredQueue.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum item com esses filtros.{" "}
              <button type="button" onClick={clearFilters} className="font-semibold text-primary hover:underline">Limpar</button>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3">Motorista</th><th className="py-2 pr-3">Gatilho</th><th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Quando</th><th className="py-2 pr-3">Mensagem</th><th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {filteredQueue.map((q) => (
                    <tr
                      key={q.id}
                      onClick={() => setQueueDetailId(q.id)}
                      className="cursor-pointer border-t border-border/60 transition hover:bg-muted/40"
                    >
                      <td className="py-2 pr-3 font-medium">{q.driver_name || q.driver_key}</td>
                      <td className="py-2 pr-3">{TRIGGER_LABELS[q.trigger] ?? q.trigger}</td>
                      <td className="py-2 pr-3">
                        <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATUS_TINT[q.status] ?? "")}>
                          {statusLabel(q.status)}{q.retry_count ? ` (${q.retry_count})` : ""}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{fmtDateTime(q.sent_at || q.created_at)}</td>
                      <td className="py-2 pr-3 max-w-[220px] truncate text-xs text-muted-foreground" title={q.message || q.last_error || ""}>
                        {q.message || q.last_error || "—"}
                      </td>
                      <td className="py-2 text-right">
                        {q.status === "pending" ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); cancelMut.mutate(q.id); }}
                            className="text-xs font-semibold text-red-600 hover:underline"
                          >
                            Cancelar
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <QueueItemModal
          id={queueDetailId}
          onClose={() => setQueueDetailId(null)}
          onChanged={invalidate}
        />
        <ManualInsertModal open={manualOpen} onClose={() => setManualOpen(false)} onCreated={invalidate} />
        <MassOutreachModal open={massOpen} onClose={() => setMassOpen(false)} onEnqueued={invalidate} />

        {/* Confirmação de ativação do envio automático */}
        <Dialog open={confirmEnableOpen} onOpenChange={(o) => { if (!o) setConfirmEnableOpen(false); }}>
          <DialogContent className="max-w-md rounded-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" /> Ativar envio automático?
              </DialogTitle>
              <DialogDescription>
                Ao ligar, o sistema passa a <strong>disparar mensagens de WhatsApp para os motoristas</strong> conforme as regras configuradas (limite diário, janela de horário e gatilhos). Confirme apenas se tem certeza de que deseja iniciar os disparos automáticos. Você ainda precisará clicar em <strong>Salvar</strong> para aplicar.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmEnableOpen(false)}>Cancelar</Button>
              <Button
                className="gap-2"
                onClick={() => { setForm({ ...form, enabled: true }); setConfirmEnableOpen(false); }}
              >
                <Power className="h-4 w-4" /> Ativar
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Opt-out */}
        <Section title="Não perturbe (opt-out)" collapsible defaultOpen={false}>
          <p className="mb-3 text-sm text-muted-foreground">Motoristas nesta lista nunca recebem mensagens automáticas.</p>
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">CPF (ou nome)</span>
              <Input value={optCpf} onChange={(e) => setOptCpf(e.target.value)} placeholder="000.000.000-00" className="w-52" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Motivo (opcional)</span>
              <Input value={optReason} onChange={(e) => setOptReason(e.target.value)} placeholder="pediu para não receber" className="w-56" />
            </label>
            <Button
              variant="secondary"
              className="gap-1.5"
              disabled={!optCpf.trim() || optoutAddMut.isPending}
              onClick={() => {
                const raw = optCpf.trim();
                const isCpf = raw.replace(/\D/g, "").length >= 11;
                optoutAddMut.mutate({ cpf: isCpf ? raw : undefined, nome: isCpf ? undefined : raw, reason: optReason.trim() || undefined });
                setOptCpf(""); setOptReason("");
              }}
            >
              <Plus className="h-4 w-4" /> Adicionar
            </Button>
          </div>
          {data.optouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguém na lista.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {data.optouts.map((o) => (
                <li key={o.driver_key} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono text-xs">{o.driver_key}</span>
                    {o.reason ? <span className="ml-2 text-muted-foreground">— {o.reason}</span> : null}
                  </span>
                  <button type="button" onClick={() => optoutRemoveMut.mutate(o.driver_key)} className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline">
                    <Trash2 className="h-3.5 w-3.5" /> Remover
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
          </>
        ) : null}
      </main>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchOutreachMessageTemplates,
  saveOutreachMessageTemplate,
  type OutreachMessageTemplate,
} from "@/services/readModels";

const KEY = ["operator", "outreach", "message-templates"];

/** Interruptor simples (mesmo visual do restante do painel). */
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function TemplateCard({ tpl }: { tpl: OutreachMessageTemplate }) {
  const qc = useQueryClient();
  const [text, setText] = useState(tpl.template);
  const [enabled, setEnabled] = useState(tpl.enabled);
  const [expanded, setExpanded] = useState(false);

  // Sincroniza quando a lista recarrega (após salvar).
  useEffect(() => {
    setText(tpl.template);
    setEnabled(tpl.enabled);
  }, [tpl.template, tpl.enabled]);

  const dirty = text !== tpl.template || enabled !== tpl.enabled;

  const saveMut = useMutation({
    mutationFn: (input: { template?: string | null; enabled?: boolean }) =>
      saveOutreachMessageTemplate({ key: tpl.key, ...input }),
    onSuccess: () => {
      toast.success(`Mensagem "${tpl.label}" salva.`);
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar."),
  });

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          title={expanded ? "Minimizar" : "Editar mensagem"}
        >
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-medium">
              {tpl.label}
              {tpl.customized ? (
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-normal text-sky-600">
                  editada
                </span>
              ) : null}
            </p>
            {expanded ? <p className="text-sm text-muted-foreground">{tpl.description}</p> : null}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-xs ${enabled ? "text-emerald-600" : "text-muted-foreground"}`}>
            {enabled ? "Ativa" : "Desligada"}
          </span>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>
      </div>

      {!expanded ? null : (
        <>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
        disabled={!enabled}
        className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] leading-relaxed disabled:opacity-50"
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">Variáveis:</span>
        {tpl.placeholders.map((p) => (
          <button
            key={p}
            type="button"
            title="Clique para copiar"
            onClick={() => {
              navigator.clipboard?.writeText(p).catch(() => {});
              toast.info(`${p} copiado`);
            }}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted-foreground/20"
          >
            {p}
          </button>
        ))}
        <span className="ml-1 text-[11px] text-muted-foreground">
          · use <code className="rounded bg-muted px-1">{"{a|b|c}"}</code> para variar o texto
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          disabled={!tpl.customized || saveMut.isPending}
          onClick={() => saveMut.mutate({ template: null, enabled })}
          title="Voltar ao texto padrão do sistema"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Restaurar padrão
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!dirty || saveMut.isPending}
          onClick={() => saveMut.mutate({ template: text, enabled })}
        >
          {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar
        </Button>
      </div>
        </>
      )}
    </div>
  );
}

export function MessageTemplatesPanel() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: fetchOutreachMessageTemplates,
    enabled: open, // só busca ao abrir a seção
  });
  const templates = useMemo(() => data?.templates ?? [], [data]);
  const activeCount = templates.filter((t) => t.enabled).length;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <div>
            <p className="font-medium">Mensagens automáticas</p>
            <p className="text-sm text-muted-foreground">
              {open
                ? "Edite o texto (com variáveis) e ligue/desligue cada mensagem."
                : "Clique para editar os textos das mensagens e ligar/desligar."}
            </p>
          </div>
        </div>
        {open && templates.length ? (
          <span className="shrink-0 text-xs text-muted-foreground">{activeCount} ativas</span>
        ) : (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {open ? "minimizar" : "abrir"}
          </span>
        )}
      </button>

      {open ? (
        isLoading ? (
          <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando mensagens…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {templates.map((tpl) => (
              <TemplateCard key={tpl.key} tpl={tpl} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

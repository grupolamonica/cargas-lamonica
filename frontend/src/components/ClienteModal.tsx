import { useEffect, useState } from "react";
import {
  Building2,
  Clock3,
  CreditCard,
  FileText,
  IdCard,
  MessageSquare,
  Package,
  Plus,
  Search,
  Shield,
  Trash2,
  Truck,
  X,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  type Cliente,
  type ClienteFormData,
  createEmptyClienteForm,
  mapClienteToFormData,
} from "@/lib/clientes";
import type { CustomBadgeItem } from "@/services/operatorAdmin";
import { shouldProxyClientLogoUrl } from "@/lib/clientLogo";
import { BADGE_ICON_MAP, BADGE_ICON_NAMES, getBadgeIcon } from "@/lib/badgeIcons";
import ClientLogo from "@/components/ClientLogo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface ClienteModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: ClienteFormData) => void;
  initialData?: Cliente | null;
  // Pré-preenche o nome ao CADASTRAR um novo cliente (sem virar modo edição).
  initialNome?: string;
}

const requirementOptions = [
  { key: "exige_rastreamento", label: "Rastreamento", icon: Search },
  { key: "exige_antt", label: "ANTT", icon: IdCard },
  { key: "exige_seguro", label: "Seguro", icon: Shield },
  { key: "exige_carga_monitorada", label: "Carga monitorada", icon: Truck },
] as const;

const reputationOptions = [
  { key: "reputacao_pagamento_rapido", label: "Pagamento rápido", icon: Clock3 },
  { key: "reputacao_bom_pagador", label: "Bom pagador", icon: CreditCard },
  { key: "reputacao_liberacao_rapida", label: "Liberação rápida", icon: Zap },
  { key: "reputacao_carga_organizada", label: "Carga organizada", icon: Package },
  { key: "reputacao_boa_comunicacao", label: "Boa comunicação", icon: MessageSquare },
] as const;

type RequirementKey = (typeof requirementOptions)[number]["key"];
type ReputationKey = (typeof reputationOptions)[number]["key"];

const DEFAULT_ICON = "Star";

const ClienteModal = ({ open, onClose, onSave, initialData, initialNome }: ClienteModalProps) => {
  const [form, setForm] = useState<ClienteFormData>(createEmptyClienteForm);
  const shouldShowLogoCleanupWarning = shouldProxyClientLogoUrl(form.logo_url);

  const [newRepLabel, setNewRepLabel] = useState("");
  const [newRepIcon, setNewRepIcon] = useState(DEFAULT_ICON);
  const [newExigLabel, setNewExigLabel] = useState("");
  const [newExigIcon, setNewExigIcon] = useState(DEFAULT_ICON);

  useEffect(() => {
    if (initialData) setForm(mapClienteToFormData(initialData));
    else if (initialNome) setForm({ ...createEmptyClienteForm(), nome: initialNome });
    else setForm(createEmptyClienteForm());
  }, [initialData, initialNome, open]);

  if (!open) {
    return null;
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSave(form);
  };

  const setField = <Field extends keyof ClienteFormData>(field: Field, value: ClienteFormData[Field]) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const addCustomBadge = (
    field: "custom_reputacoes" | "custom_exigencias",
    label: string,
    icon_name: string,
    resetLabel: () => void,
    resetIcon: () => void,
  ) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const item: CustomBadgeItem = { id: crypto.randomUUID(), label: trimmed, icon_name, active: true };
    setForm((f) => ({ ...f, [field]: [...f[field], item] }));
    resetLabel();
    resetIcon();
  };

  const toggleCustomBadge = (field: "custom_reputacoes" | "custom_exigencias", id: string) => {
    setForm((f) => ({
      ...f,
      [field]: f[field].map((b) => (b.id === id ? { ...b, active: !b.active } : b)),
    }));
  };

  const removeCustomBadge = (field: "custom_reputacoes" | "custom_exigencias", id: string) => {
    setForm((f) => ({ ...f, [field]: f[field].filter((b) => b.id !== id) }));
  };

  const inputClass =
    "admin-input-surface min-h-14 w-full rounded-2xl border px-4 text-[15px] font-medium outline-none transition-all duration-200 placeholder:text-muted-foreground/90 focus:border-primary/35 focus:ring-4 focus:ring-primary/10";
  const textareaClass = `${inputClass} min-h-[120px] resize-none py-3.5`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-[hsl(224_40%_10%/0.42)] backdrop-blur-md" />

      <form
        role="dialog"
        aria-modal="true"
        aria-label={initialData ? "Editar embarcador" : "Novo embarcador"}
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
        className="admin-dialog-surface relative max-h-[92vh] w-full max-w-[920px] overflow-y-auto rounded-[32px] border shadow-[0_36px_80px_-34px_rgba(15,23,42,0.35)] animate-slide-up"
      >
        <div className="border-b border-border/70 px-6 py-5 sm:px-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Cadastro de cliente</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                {initialData ? "Editar embarcador" : "Novo embarcador"}
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Informações essenciais para o motorista decidir rápido.
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="admin-soft-button flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors duration-200 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-4 px-6 py-6 sm:px-8">
          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">1. Identificação</p>
                <h3 className="text-lg font-semibold text-foreground">Quem está embarcando</h3>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-foreground">Nome da empresa *</label>
                    <input
                      type="text"
                      placeholder="Ex: Nestle"
                      value={form.nome}
                      onChange={(event) => setField("nome", event.target.value)}
                      required
                      autoFocus
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-semibold text-foreground">URL da logo</label>
                    <input
                      type="url"
                      placeholder="Ex: https://site.com/logo.png"
                      value={form.logo_url || ""}
                      onChange={(event) => setField("logo_url", event.target.value || null)}
                      className={inputClass}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Cole o link direto da imagem para ela aparecer corretamente na tela do motorista.
                    </p>
                    {shouldShowLogoCleanupWarning ? (
                      <p className="admin-warning-callout mt-3 rounded-2xl border px-3 py-2 text-xs font-medium leading-5">
                        Para logos externos, o sistema tenta limpar automaticamente fundos claros e quadriculados. A
                        melhor qualidade continua sendo uma logo oficial em PNG transparente ou SVG.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <p className="text-sm font-semibold text-foreground">Preview da logo</p>
                  <ClientLogo
                    name={form.nome || "Cliente"}
                    logoUrl={form.logo_url}
                    className="admin-card-surface-strong h-[182px] w-full border"
                    imageClassName="p-4"
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-foreground">Descrição da empresa</label>
                <textarea
                  placeholder="Ex: empresa com entrega rápida, prioridade no retorno e atendimento direto"
                  value={form.descricao || ""}
                  onChange={(event) => setField("descricao", event.target.value || null)}
                  rows={3}
                  className={textareaClass}
                />
              </div>
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">2. Logos adicionais</p>
                <h3 className="text-lg font-semibold text-foreground">Logos por contexto</h3>
              </div>
            </div>

            <div className="mt-5 space-y-6">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-foreground">Logo — cargas disponíveis</label>
                  <input
                    type="url"
                    placeholder="Ex: https://site.com/logo-card.png"
                    value={form.logo_url_card || ""}
                    onChange={(event) => setField("logo_url_card", event.target.value || null)}
                    className={inputClass}
                  />
                  <p className="text-xs text-muted-foreground">
                    Aparece no card da lista de cargas disponíveis para o motorista.
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-semibold text-foreground">Preview</p>
                  <ClientLogo
                    name={form.nome || "Cliente"}
                    logoUrl={form.logo_url_card}
                    className="admin-card-surface-strong h-[182px] w-full border"
                    imageClassName="p-4"
                  />
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-foreground">Logo — cargas próximas</label>
                  <input
                    type="url"
                    placeholder="Ex: https://site.com/logo-proximas.png"
                    value={form.logo_url_proximas || ""}
                    onChange={(event) => setField("logo_url_proximas", event.target.value || null)}
                    className={inputClass}
                  />
                  <p className="text-xs text-muted-foreground">
                    Aparece no card de cargas próximas a você na tela inicial do motorista.
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-semibold text-foreground">Preview</p>
                  <ClientLogo
                    name={form.nome || "Cliente"}
                    logoUrl={form.logo_url_proximas}
                    className="admin-card-surface-strong h-[182px] w-full border"
                    imageClassName="p-4"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">3. Padrão de pagamento</p>
                <h3 className="text-lg font-semibold text-foreground">Como esse cliente paga</h3>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold text-foreground">Forma de pagamento</label>
                <input
                  type="text"
                  placeholder="Ex: 80% adiantado / 20% entrega"
                  value={form.forma_pagamento || ""}
                  onChange={(event) => setField("forma_pagamento", event.target.value || null)}
                  className={inputClass}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-foreground">Prazo de pagamento</label>
                <input
                  type="text"
                  placeholder="Ex: 7 dias, à vista, 15 dias"
                  value={form.prazo_pagamento || ""}
                  onChange={(event) => setField("prazo_pagamento", event.target.value || null)}
                  className={inputClass}
                />
              </div>
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">4. Exigências padrão</p>
                <h3 className="text-lg font-semibold text-foreground">Mini cards interativos</h3>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {requirementOptions.map((option) => {
                const Icon = option.icon;
                const active = form[option.key];

                return (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setField(option.key as RequirementKey, !active)}
                    className={cn(
                      "group flex min-h-[104px] items-start gap-3 rounded-[24px] border px-4 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 cursor-pointer",
                      active
                        ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white shadow-[0_18px_28px_-18px_rgba(2,36,131,0.65)]"
                        : "admin-chip-inactive",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-colors duration-200",
                        active ? "bg-white/14 text-white" : "admin-chip-icon-neutral",
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>

                    <div className="min-w-0">
                      <p className={cn("text-base font-semibold", active ? "text-white" : "text-foreground")}>
                        {option.label}
                      </p>
                      <p className={cn("mt-1 text-sm", active ? "text-white/78" : "text-muted-foreground")}>
                        {active ? "Obrigatório" : "Não obrigatório"}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">5. Reputação</p>
                <h3 className="text-lg font-semibold text-foreground">Sinais positivos do embarcador</h3>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {reputationOptions.map((option) => {
                const Icon = option.icon;
                const active = form[option.key];

                return (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setField(option.key as ReputationKey, !active)}
                    className={cn(
                      "group flex min-h-[104px] items-start gap-3 rounded-[24px] border px-4 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 cursor-pointer",
                      active
                        ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white shadow-[0_18px_28px_-18px_rgba(2,36,131,0.65)]"
                        : "admin-chip-inactive",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-colors duration-200",
                        active ? "bg-white/14 text-white" : "admin-chip-icon-neutral",
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>

                    <div className="min-w-0">
                      <p className={cn("text-base font-semibold", active ? "text-white" : "text-foreground")}>
                        {option.label}
                      </p>
                      <p className={cn("mt-1 text-sm", active ? "text-white/78" : "text-muted-foreground")}>
                        {active ? "Marcado" : "Não marcado"}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">6. Reputações personalizadas</p>
                <h3 className="text-lg font-semibold text-foreground">Badges de reputação extras</h3>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {form.custom_reputacoes.map((badge) => {
                const Icon = getBadgeIcon(badge.icon_name);
                return (
                  <div
                    key={badge.id}
                    className={cn(
                      "flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all duration-200",
                      badge.active
                        ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white"
                        : "admin-chip-inactive",
                    )}
                  >
                    <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", badge.active ? "bg-white/14" : "admin-chip-icon-neutral")}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className={cn("flex-1 text-sm font-semibold", badge.active ? "text-white" : "text-foreground")}>{badge.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleCustomBadge("custom_reputacoes", badge.id)}
                      className={cn("text-xs font-semibold px-2 py-1 rounded-lg cursor-pointer transition-colors", badge.active ? "bg-white/15 text-white hover:bg-white/25" : "bg-muted hover:bg-muted/80 text-muted-foreground")}
                    >
                      {badge.active ? "Ativo" : "Inativo"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCustomBadge("custom_reputacoes", badge.id)}
                      className={cn("flex h-7 w-7 items-center justify-center rounded-lg cursor-pointer transition-colors", badge.active ? "hover:bg-white/20 text-white/70" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive")}
                      aria-label="Remover badge"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}

              <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border/60 bg-muted/20 p-3">
                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Ex: Câmera embarcada"
                    value={newRepLabel}
                    onChange={(e) => setNewRepLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomBadge("custom_reputacoes", newRepLabel, newRepIcon, () => setNewRepLabel(""), () => setNewRepIcon(DEFAULT_ICON)); } }}
                    className="admin-input-surface h-10 flex-1 rounded-xl border px-3 text-sm font-medium outline-none transition-all placeholder:text-muted-foreground/70 focus:border-primary/35 focus:ring-4 focus:ring-primary/10"
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="admin-soft-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border cursor-pointer"
                        aria-label="Escolher ícone"
                      >
                        {(() => { const Icon = getBadgeIcon(newRepIcon); return <Icon className="h-4 w-4" />; })()}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto p-2">
                      <div className="grid grid-cols-5 gap-1">
                        {BADGE_ICON_NAMES.map((name) => {
                          const Icon = BADGE_ICON_MAP[name];
                          return (
                            <button
                              key={name}
                              type="button"
                              title={name}
                              onClick={() => setNewRepIcon(name)}
                              className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors cursor-pointer hover:bg-primary/10", newRepIcon === name && "bg-primary/15 ring-1 ring-primary/40")}
                            >
                              <Icon className="h-4 w-4" />
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
                <button
                  type="button"
                  onClick={() => addCustomBadge("custom_reputacoes", newRepLabel, newRepIcon, () => setNewRepLabel(""), () => setNewRepIcon(DEFAULT_ICON))}
                  className="admin-primary-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl cursor-pointer"
                  aria-label="Adicionar reputação"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">7. Exigências personalizadas</p>
                <h3 className="text-lg font-semibold text-foreground">Exigências extras</h3>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {form.custom_exigencias.map((badge) => {
                const Icon = getBadgeIcon(badge.icon_name);
                return (
                  <div
                    key={badge.id}
                    className={cn(
                      "flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all duration-200",
                      badge.active
                        ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white"
                        : "admin-chip-inactive",
                    )}
                  >
                    <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", badge.active ? "bg-white/14" : "admin-chip-icon-neutral")}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className={cn("flex-1 text-sm font-semibold", badge.active ? "text-white" : "text-foreground")}>{badge.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleCustomBadge("custom_exigencias", badge.id)}
                      className={cn("text-xs font-semibold px-2 py-1 rounded-lg cursor-pointer transition-colors", badge.active ? "bg-white/15 text-white hover:bg-white/25" : "bg-muted hover:bg-muted/80 text-muted-foreground")}
                    >
                      {badge.active ? "Ativo" : "Inativo"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCustomBadge("custom_exigencias", badge.id)}
                      className={cn("flex h-7 w-7 items-center justify-center rounded-lg cursor-pointer transition-colors", badge.active ? "hover:bg-white/20 text-white/70" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive")}
                      aria-label="Remover exigência"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}

              <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border/60 bg-muted/20 p-3">
                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Ex: Câmera obrigatória"
                    value={newExigLabel}
                    onChange={(e) => setNewExigLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomBadge("custom_exigencias", newExigLabel, newExigIcon, () => setNewExigLabel(""), () => setNewExigIcon(DEFAULT_ICON)); } }}
                    className="admin-input-surface h-10 flex-1 rounded-xl border px-3 text-sm font-medium outline-none transition-all placeholder:text-muted-foreground/70 focus:border-primary/35 focus:ring-4 focus:ring-primary/10"
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="admin-soft-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border cursor-pointer"
                        aria-label="Escolher ícone"
                      >
                        {(() => { const Icon = getBadgeIcon(newExigIcon); return <Icon className="h-4 w-4" />; })()}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto p-2">
                      <div className="grid grid-cols-5 gap-1">
                        {BADGE_ICON_NAMES.map((name) => {
                          const Icon = BADGE_ICON_MAP[name];
                          return (
                            <button
                              key={name}
                              type="button"
                              title={name}
                              onClick={() => setNewExigIcon(name)}
                              className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors cursor-pointer hover:bg-primary/10", newExigIcon === name && "bg-primary/15 ring-1 ring-primary/40")}
                            >
                              <Icon className="h-4 w-4" />
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
                <button
                  type="button"
                  onClick={() => addCustomBadge("custom_exigencias", newExigLabel, newExigIcon, () => setNewExigLabel(""), () => setNewExigIcon(DEFAULT_ICON))}
                  className="admin-primary-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl cursor-pointer"
                  aria-label="Adicionar exigência"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>

          <section className="admin-soft-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">8. Observações</p>
                <h3 className="text-lg font-semibold text-foreground">Notas rápidas da operação</h3>
              </div>
            </div>

            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-foreground">Observações</label>
              <textarea
                placeholder="Ex: Liberação rápida, pagamento confiavel..."
                value={form.observacoes || ""}
                onChange={(event) => setField("observacoes", event.target.value || null)}
                rows={4}
                className={textareaClass}
              />
            </div>
          </section>
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border/70 px-6 py-5 sm:flex-row sm:items-center sm:justify-end sm:px-8">
          <button
            type="button"
            onClick={onClose}
            className="admin-soft-button inline-flex h-12 items-center justify-center rounded-2xl border px-5 text-sm font-semibold transition-colors duration-200 cursor-pointer"
          >
            Cancelar
          </button>

          <button
            type="submit"
            className="admin-primary-button inline-flex h-12 items-center justify-center rounded-2xl px-6 text-sm font-semibold text-white cursor-pointer"
          >
            Salvar Cliente
          </button>
        </div>
      </form>
    </div>
  );
};

export default ClienteModal;

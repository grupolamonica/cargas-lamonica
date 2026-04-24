import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { VEHICLE_PROFILE_OPTIONS, normalizeVehicleProfile } from "@/lib/vehicleProfiles";

export interface RouteFormData {
  origem: string;
  destino: string;
  distancia_km: string;
  duracao_horas: string;
  tempo_estimado_horas: string;
  perfil_padrao: string;
  valor_padrao: string;
  bonus_padrao: string;
  ativa: boolean;
  observacoes: string;
}

interface RouteModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: RouteFormData) => Promise<void>;
  onResolveMetrics: (origin: string, destination: string) => Promise<{ distancia_km: number | null; duracao_horas: number | null }>;
  initialData?: RouteFormData | null;
  supportsCatalogFields: boolean;
}

const emptyForm: RouteFormData = {
  origem: "",
  destino: "",
  distancia_km: "",
  duracao_horas: "",
  tempo_estimado_horas: "",
  perfil_padrao: "CARRETA",
  valor_padrao: "",
  bonus_padrao: "",
  ativa: true,
  observacoes: "",
};

const RouteModal = ({
  open,
  onClose,
  onSave,
  onResolveMetrics,
  initialData,
  supportsCatalogFields,
}: RouteModalProps) => {
  const [form, setForm] = useState<RouteFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [resolvingMetrics, setResolvingMetrics] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setForm(
      initialData
        ? {
            ...initialData,
            perfil_padrao: normalizeVehicleProfile(initialData.perfil_padrao),
          }
        : emptyForm,
    );
  }, [initialData, open]);

  if (!open) {
    return null;
  }

  const inputClass =
    "w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all duration-200 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring";

  const handleResolveMetrics = async () => {
    setResolvingMetrics(true);

    try {
      const metrics = await onResolveMetrics(form.origem, form.destino);

      setForm((currentForm) => ({
        ...currentForm,
        distancia_km: metrics.distancia_km !== null ? String(metrics.distancia_km) : currentForm.distancia_km,
        duracao_horas: metrics.duracao_horas !== null ? String(metrics.duracao_horas) : currentForm.duracao_horas,
        tempo_estimado_horas:
          !currentForm.tempo_estimado_horas && metrics.duracao_horas !== null
            ? String(metrics.duracao_horas)
            : currentForm.tempo_estimado_horas,
      }));
    } finally {
      setResolvingMetrics(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);

    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={initialData ? "Editar rota padrao" : "Cadastrar nova rota"}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
        className="relative max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-2xl bg-card shadow-elevated animate-slide-up"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {initialData ? "Editar rota padrao" : "Cadastrar nova rota"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Defina origem, destino, metricas e os valores padrao que o operador quer usar nessa rota.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {!supportsCatalogFields ? (
            <div className="rounded-2xl border border-amber-300/45 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Valor padrao, bonus, perfil sugerido e observacoes dependem da migration nova da tabela de rotas.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Origem *</label>
              <input
                type="text"
                placeholder="Ex: Sao Paulo/SP"
                value={form.origem}
                onChange={(event) => setForm({ ...form, origem: event.target.value })}
                required
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Destino *</label>
              <input
                type="text"
                placeholder="Ex: Salvador/BA"
                value={form.destino}
                onChange={(event) => setForm({ ...form, destino: event.target.value })}
                required
                className={inputClass}
              />
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => void handleResolveMetrics()}
                disabled={resolvingMetrics || !form.origem.trim() || !form.destino.trim()}
                className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg border border-primary/15 bg-primary/6 px-4 text-sm font-semibold text-primary transition-colors duration-200 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resolvingMetrics ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Buscar metricas
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Distancia (km) *</label>
              <input
                type="text"
                placeholder="Ex: 420"
                value={form.distancia_km}
                onChange={(event) => setForm({ ...form, distancia_km: event.target.value })}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Duracao da rota (h) *</label>
              <input
                type="text"
                placeholder="Ex: 7.5"
                value={form.duracao_horas}
                onChange={(event) => setForm({ ...form, duracao_horas: event.target.value })}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Tempo estimado (h)</label>
              <input
                type="text"
                placeholder="Ex: 8"
                value={form.tempo_estimado_horas}
                onChange={(event) => setForm({ ...form, tempo_estimado_horas: event.target.value })}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Perfil sugerido</label>
              <select
                value={form.perfil_padrao}
                onChange={(event) => setForm({ ...form, perfil_padrao: event.target.value })}
                disabled={!supportsCatalogFields}
                className={`${inputClass} cursor-pointer`}
              >
                {VEHICLE_PROFILE_OPTIONS.map((routeProfile) => (
                  <option key={routeProfile.value} value={routeProfile.value}>
                    {routeProfile.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Valor padrao (R$)</label>
              <input
                type="text"
                placeholder="Ex: 3200,00"
                value={form.valor_padrao}
                onChange={(event) => setForm({ ...form, valor_padrao: event.target.value })}
                disabled={!supportsCatalogFields}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Bonus padrao (R$)</label>
              <input
                type="text"
                placeholder="Ex: 250,00"
                value={form.bonus_padrao}
                onChange={(event) => setForm({ ...form, bonus_padrao: event.target.value })}
                disabled={!supportsCatalogFields}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Observacoes da rota</label>
            <textarea
              value={form.observacoes}
              onChange={(event) => setForm({ ...form, observacoes: event.target.value })}
              disabled={!supportsCatalogFields}
              placeholder="Ex: Janela de entrega apertada, pedagio alto, rota de retorno..."
              className="min-h-[110px] w-full rounded-lg border border-border bg-secondary px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground transition-all duration-200 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-secondary/40 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Rota ativa no catalogo</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Rotas inativas continuam salvas, mas saem da visao de operacao principal.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={form.ativa}
                onChange={(event) => setForm({ ...form, ativa: event.target.checked })}
                disabled={!supportsCatalogFields}
                className="h-4 w-4 rounded border-border accent-ring"
              />
              <span className="text-sm font-medium text-foreground">Ativa</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="gradient-blue inline-flex cursor-pointer items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-blue transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated disabled:cursor-not-allowed disabled:opacity-70"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Salvar rota
          </button>
        </div>
      </form>
    </div>
  );
};

export default RouteModal;

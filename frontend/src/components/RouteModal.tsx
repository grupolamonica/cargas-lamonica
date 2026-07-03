import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { VEHICLE_PROFILE_OPTIONS, normalizeVehicleProfile, EIXOS_OPTIONS } from "@/lib/vehicleProfiles";
import { CitySelector } from "@/components/CitySelector";

export interface RouteFormData {
  origem: string;
  destino: string;
  distancia_km: string;
  tempo_estimado_horas: string;
  perfil_padrao: string;
  eixos: number;
  valor_padrao: string;
  bonus_padrao: string;
  bonus_exigencias: string;
  ativa: boolean;
  cliente_id: string | null;
}

export interface ClienteOption {
  id: string;
  nome: string;
}

interface RouteModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: RouteFormData) => Promise<void>;
  initialData?: RouteFormData | null;
  supportsCatalogFields: boolean;
  clientes: ClienteOption[];
}

const emptyForm: RouteFormData = {
  origem: "",
  destino: "",
  distancia_km: "",
  tempo_estimado_horas: "",
  perfil_padrao: "CARRETA",
  eixos: 0,
  valor_padrao: "",
  bonus_padrao: "",
  bonus_exigencias: "",
  ativa: true,
  cliente_id: null,
};

const RouteModal = ({
  open,
  onClose,
  onSave,
  initialData,
  supportsCatalogFields,
  clientes,
}: RouteModalProps) => {
  const [form, setForm] = useState<RouteFormData>(emptyForm);
  const [saving, setSaving] = useState(false);

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
        aria-label={initialData ? "Editar rota padrão" : "Cadastrar nova rota"}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
        className="relative max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-2xl bg-card shadow-elevated animate-slide-up"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {initialData ? "Editar rota padrão" : "Cadastrar nova rota"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Defina origem, destino, métricas e os valores padrão que o operador quer usar nessa rota.
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
              Valor padrão, bônus e perfil sugerido dependem da migration nova da tabela de rotas.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Origem *</label>
              <CitySelector
                value={form.origem}
                onChange={(value) => setForm((current) => ({ ...current, origem: value }))}
                placeholder="Buscar cidade de origem"
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Destino *</label>
              <CitySelector
                value={form.destino}
                onChange={(value) => setForm((current) => ({ ...current, destino: value }))}
                placeholder="Buscar cidade de destino"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Distância (km) *</label>
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
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Tempo estimado (h) *</label>
              <input
                type="text"
                placeholder="Ex: 8"
                value={form.tempo_estimado_horas}
                onChange={(event) => setForm({ ...form, tempo_estimado_horas: event.target.value })}
                required
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Cliente</label>
            <select
              value={form.cliente_id ?? ""}
              onChange={(event) =>
                setForm({ ...form, cliente_id: event.target.value || null })
              }
              className={`${inputClass} cursor-pointer`}
            >
              <option value="">Sem cliente vinculado</option>
              {clientes.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.nome}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Vincule esta rota a um embarcador. Cada rota pode ser associada a um cliente — ao selecionar um novo, a rota é transferida.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Perfil do veículo *</label>
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
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Eixos</label>
              <select
                value={form.eixos}
                onChange={(event) => setForm({ ...form, eixos: Number(event.target.value) })}
                disabled={!supportsCatalogFields}
                className={`${inputClass} cursor-pointer`}
              >
                {EIXOS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="rounded-2xl border border-primary/12 bg-primary/[0.04] px-4 py-2.5 text-xs text-muted-foreground">
            Mesma origem e destino pode ter uma rota por veículo (perfil + eixos), cada uma com seu próprio valor e bônus.
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Valor padrão (R$)</label>
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
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Bônus padrão (R$)</label>
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

          <div className="admin-accent-tint rounded-2xl border px-4 py-4 shadow-[0_16px_28px_-24px_hsl(224_94%_37%/0.25)]">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Regras para liberar o bônus</p>
            <h3 className="mt-2 text-sm font-semibold text-foreground">Explique o que o motorista precisa cumprir</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Escreva uma regra por linha. Esse texto vai aparecer em destaque na especificação da carga.
            </p>
            <textarea
              value={form.bonus_exigencias}
              onChange={(event) => setForm({ ...form, bonus_exigencias: event.target.value })}
              disabled={!supportsCatalogFields}
              rows={5}
              placeholder={"Ex: Entregar dentro da janela acordada\nChecklist e comprovante enviados\nSeguir todas as normas operacionais"}
              className="mt-4 min-h-[132px] w-full resize-y rounded-lg border border-border bg-secondary px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground transition-all duration-200 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-secondary/40 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Rota ativa no catálogo</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Rotas inativas continuam salvas, mas saem da visão de operação principal.
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

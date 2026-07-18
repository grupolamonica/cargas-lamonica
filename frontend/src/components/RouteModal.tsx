import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { VEHICLE_PROFILE_OPTIONS, normalizeVehicleProfile, EIXOS_OPTIONS } from "@/lib/vehicleProfiles";
import { CitySelector } from "@/components/CitySelector";
import { type AssignableRouteOption } from "@/lib/assignableRoutes";

// Uma tarifa = combinação (perfil + eixos) com valor/bônus próprios. `key` é
// só um id local pra renderização/edição das linhas (não vai pro backend).
export interface RouteTarifaFormRow {
  key: string;
  perfil: string;
  eixos: number;
  valor: string;
  bonus: string;
  bonus_exigencias: string;
}

// Uma tarifa = combinação (perfil + eixos) com valor/bônus próprios. `key` é
// só um id local pra renderização/edição das linhas (não vai pro backend).
export interface RouteTarifaFormRow {
  key: string;
  perfil: string;
  eixos: number;
  valor: string;
  bonus: string;
  bonus_exigencias: string;
}

export interface RouteFormData {
  origem: string;
  destino: string;
  distancia_km: string;
  tempo_estimado_horas: string;
  ativa: boolean;
  cliente_id: string | null;
  tarifas: RouteTarifaFormRow[];
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
  // Opcional: quando passado, mostra um seletor "copiar de rota já cadastrada"
  // que preenche distância/tempo/tarifa a partir de uma rota existente (mantém o
  // trecho atual). Usado na remediação de cargas importadas sem rota.
  existingRoutes?: AssignableRouteOption[];
}

function makeTarifaRow(overrides: Partial<RouteTarifaFormRow> = {}): RouteTarifaFormRow {
  return {
    key: crypto.randomUUID(),
    perfil: "CARRETA",
    eixos: 0,
    valor: "",
    bonus: "",
    bonus_exigencias: "",
    ...overrides,
  };
}

function emptyForm(): RouteFormData {
  return {
    origem: "",
    destino: "",
    distancia_km: "",
    tempo_estimado_horas: "",
    ativa: true,
    cliente_id: null,
    tarifas: [makeTarifaRow()],
  };
}

const RouteModal = ({
  open,
  onClose,
  onSave,
  initialData,
  supportsCatalogFields,
  clientes,
  existingRoutes,
}: RouteModalProps) => {
  const [form, setForm] = useState<RouteFormData>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Copia métricas/tarifa de uma rota já cadastrada; PRESERVA o trecho atual
  // (origem/destino da carga) — só agiliza o preenchimento de valor/distância.
  const applyExistingRoute = (routeId: string) => {
    const r = existingRoutes?.find((route) => route.id === routeId);
    if (!r) return;
    const tempo = r.tempo_estimado_horas ?? r.duracao_horas;
    setForm((current) => ({
      ...current,
      distancia_km: r.distancia_km != null ? String(r.distancia_km) : current.distancia_km,
      tempo_estimado_horas: tempo != null ? String(tempo) : current.tempo_estimado_horas,
      tarifas: [
        makeTarifaRow({
          perfil: normalizeVehicleProfile(r.perfil_padrao ?? "CARRETA"),
          eixos: r.eixos ?? 0,
          valor: r.valor_padrao != null ? String(r.valor_padrao) : "",
          bonus: r.bonus_padrao != null ? String(r.bonus_padrao) : "",
        }),
      ],
    }));
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    if (initialData) {
      setForm({
        ...initialData,
        tarifas:
          initialData.tarifas.length > 0
            ? initialData.tarifas.map((tarifa) => ({
                ...tarifa,
                key: tarifa.key || crypto.randomUUID(),
                perfil: normalizeVehicleProfile(tarifa.perfil),
              }))
            : [makeTarifaRow()],
      });
      return;
    }

    setForm(emptyForm());
  }, [initialData, open]);

  if (!open) {
    return null;
  }

  const inputClass =
    "w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all duration-200 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring";

  // (perfil + eixos) é a identidade da tarifa; duas linhas iguais são ambíguas.
  const dedupeKeys = form.tarifas.map((tarifa) => `${normalizeVehicleProfile(tarifa.perfil)}|${tarifa.eixos}`);
  const hasDuplicateTarifa = new Set(dedupeKeys).size !== dedupeKeys.length;

  const updateTarifa = (key: string, patch: Partial<RouteTarifaFormRow>) => {
    setForm((current) => ({
      ...current,
      tarifas: current.tarifas.map((tarifa) => (tarifa.key === key ? { ...tarifa, ...patch } : tarifa)),
    }));
  };

  const addTarifa = () => {
    setForm((current) => ({ ...current, tarifas: [...current.tarifas, makeTarifaRow()] }));
  };

  const removeTarifa = (key: string) => {
    setForm((current) => ({
      ...current,
      // Sempre mantém ao menos uma linha — a rota precisa de pelo menos uma tarifa.
      tarifas:
        current.tarifas.length <= 1
          ? current.tarifas
          : current.tarifas.filter((tarifa) => tarifa.key !== key),
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (hasDuplicateTarifa) {
      return;
    }
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
        className="relative max-h-[92vh] w-full max-w-[760px] overflow-y-auto rounded-2xl bg-card shadow-elevated animate-slide-up"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {initialData ? "Editar rota padrão" : "Cadastrar nova rota"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Defina o trecho e cadastre um valor/bônus para cada tipo de veículo que roda nele.
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

          {existingRoutes && existingRoutes.length > 0 ? (
            <div className="rounded-2xl border border-border/70 bg-secondary/40 px-4 py-3">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Copiar de rota já cadastrada (opcional)
              </label>
              <select
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) applyExistingRoute(event.target.value);
                }}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">Selecione uma rota para copiar valor/tarifa…</option>
                {existingRoutes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.origem} → {route.destino}
                    {route.valor_padrao != null ? ` · R$ ${route.valor_padrao}` : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Mantém o trecho da carga e copia distância, tempo e tarifa da rota escolhida.
              </p>
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
              onChange={(event) => setForm({ ...form, cliente_id: event.target.value || null })}
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
              Cada rota pode ser associada a um cliente — ao selecionar um novo, a rota é transferida.
            </p>
          </div>

          {/* ── Tarifas por veículo ─────────────────────────────────────── */}
          <div className="rounded-2xl border border-primary/12 bg-primary/[0.03] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Tarifas por veículo</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Um valor e bônus para cada Perfil + Eixos que roda neste trecho.
                </p>
              </div>
              <button
                type="button"
                onClick={addTarifa}
                disabled={!supportsCatalogFields}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition-colors duration-200 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar veículo
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {form.tarifas.map((tarifa) => (
                <div
                  key={tarifa.key}
                  className="rounded-xl border border-border/70 bg-card/70 p-3"
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Perfil *</label>
                      <select
                        value={tarifa.perfil}
                        onChange={(event) => updateTarifa(tarifa.key, { perfil: event.target.value })}
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
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Eixos</label>
                      <select
                        value={tarifa.eixos}
                        onChange={(event) => updateTarifa(tarifa.key, { eixos: Number(event.target.value) })}
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
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Valor (R$)</label>
                      <input
                        type="text"
                        placeholder="Ex: 3200,00"
                        value={tarifa.valor}
                        onChange={(event) => updateTarifa(tarifa.key, { valor: event.target.value })}
                        disabled={!supportsCatalogFields}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Bônus (R$)</label>
                      <input
                        type="text"
                        placeholder="Ex: 250,00"
                        value={tarifa.bonus}
                        onChange={(event) => updateTarifa(tarifa.key, { bonus: event.target.value })}
                        disabled={!supportsCatalogFields}
                        className={inputClass}
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => removeTarifa(tarifa.key)}
                        disabled={form.tarifas.length <= 1}
                        aria-label="Remover veículo"
                        className="inline-flex h-[42px] w-full items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition-colors duration-200 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 sm:w-[42px]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2">
                    <input
                      type="text"
                      placeholder="Regras para liberar o bônus (opcional)"
                      value={tarifa.bonus_exigencias}
                      onChange={(event) => updateTarifa(tarifa.key, { bonus_exigencias: event.target.value })}
                      disabled={!supportsCatalogFields}
                      className={`${inputClass} text-xs`}
                    />
                  </div>
                </div>
              ))}
            </div>

            {hasDuplicateTarifa ? (
              <p className="mt-3 text-xs font-medium text-destructive">
                Há tarifas repetidas (mesmo perfil e nº de eixos). Cada combinação só pode aparecer uma vez.
              </p>
            ) : null}
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
            disabled={saving || hasDuplicateTarifa}
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

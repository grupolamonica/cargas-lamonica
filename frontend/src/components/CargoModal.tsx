import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, X } from "lucide-react";

import {
  applyAssignableRouteToCargoDraft,
  findAssignableRouteByLocations,
  getAssignableRouteLabel,
  type AssignableRouteOption,
} from "@/lib/assignableRoutes";
import { VEHICLE_PROFILE_OPTIONS, normalizeVehicleProfile } from "@/lib/vehicleProfiles";

interface CargoData {
  data: string;
  horario: string;
  route_key?: string;
  origem: string;
  destino: string;
  perfil: string;
  valor?: string;
  bonus?: string;
  bonus_exigencias?: string;
  driver_visibility: "PUBLIC" | "PREMIUM";
  cliente_id?: string;
  status: string;
  is_template: boolean;
  sheet_data_carregamento?: string;
  sheet_data_descarga?: string;
}

const DRAFT_STATUS = "DRAFT";
const OPEN_STATUS = "OPEN";
const PUBLIC_VISIBILITY = "PUBLIC";
const PREMIUM_VISIBILITY = "PREMIUM";

interface CargoModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: CargoData) => void;
  clientes: { id: string; nome: string }[];
  routes: AssignableRouteOption[];
  initialData?: CargoData | null;
  lockedClientId?: string;
  lockedClientLabel?: string;
  canEditValues?: boolean;
}

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function buildDefaultCargoSchedule(now = new Date()) {
  return {
    data: `${now.getFullYear()}-${padTwoDigits(now.getMonth() + 1)}-${padTwoDigits(now.getDate())}`,
    horario: `${padTwoDigits(now.getHours())}:${padTwoDigits(now.getMinutes())}`,
  };
}

function formatRouteMoney(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "A combinar";
  }

  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatRouteHours(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "A confirmar";
  }

  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1,
  })} h`;
}

const CargoModal = ({
  open,
  onClose,
  onSave,
  clientes,
  routes,
  initialData,
  lockedClientId = "",
  lockedClientLabel = "",
  canEditValues = true,
}: CargoModalProps) => {
  const defaultSchedule = buildDefaultCargoSchedule();
  const hasUserEditedValuesRef = useRef(false);
  const [form, setForm] = useState<CargoData>({
    ...defaultSchedule,
    route_key: "",
    origem: "",
    destino: "",
    perfil: "CARRETA",
    valor: "",
    bonus: "",
    bonus_exigencias: "",
    driver_visibility: PUBLIC_VISIBILITY,
    cliente_id: "",
    status: DRAFT_STATUS,
    is_template: false,
  });

  useEffect(() => {
    if (initialData) {
      setForm({
        ...initialData,
        perfil: normalizeVehicleProfile(initialData.perfil),
      });
      return;
    }

    setForm({
      ...buildDefaultCargoSchedule(),
      route_key: "",
      origem: "",
      destino: "",
      perfil: "CARRETA",
      valor: "",
      bonus: "",
      bonus_exigencias: "",
      driver_visibility: PUBLIC_VISIBILITY,
      cliente_id: "",
      status: DRAFT_STATUS,
      is_template: false,
      sheet_data_carregamento: "",
      sheet_data_descarga: "",
    });
  }, [initialData, open]);

  useEffect(() => {
    hasUserEditedValuesRef.current = false;
  }, [open]);

  const statusManagedByClaimLifecycle = ![DRAFT_STATUS, OPEN_STATUS].includes(form.status);
  const isClientLocked = lockedClientId.trim() !== "";
  const selectableRoutes = routes.filter((route) => route.ativa || route.route_key === form.route_key);
  const autoMatchedRoute = useMemo(
    () => findAssignableRouteByLocations(selectableRoutes, form.origem, form.destino),
    [form.destino, form.origem, selectableRoutes],
  );
  const selectedRoute = selectableRoutes.find((route) => route.route_key === form.route_key) || autoMatchedRoute || null;

  useEffect(() => {
    if (!autoMatchedRoute) {
      return;
    }
    if (hasUserEditedValuesRef.current) {
      return;
    }

    setForm((currentForm) => applyAssignableRouteToCargoDraft(currentForm, autoMatchedRoute));
  }, [autoMatchedRoute]);

  useEffect(() => {
    if (!isClientLocked) {
      return;
    }

    setForm((currentForm) => {
      if (currentForm.cliente_id === lockedClientId) {
        return currentForm;
      }

      return {
        ...currentForm,
        cliente_id: lockedClientId,
      };
    });
  }, [isClientLocked, lockedClientId]);

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const fallbackSchedule = buildDefaultCargoSchedule();
    onSave(
      isClientLocked
        ? {
            ...form,
            data: form.data || fallbackSchedule.data,
            horario: form.horario || fallbackSchedule.horario,
            cliente_id: lockedClientId,
          }
        : {
            ...form,
            data: form.data || fallbackSchedule.data,
            horario: form.horario || fallbackSchedule.horario,
          },
    );
  };

  const handleRouteChange = (routeKey: string) => {
    const nextRoute = selectableRoutes.find((route) => route.route_key === routeKey) || null;

    if (!nextRoute) {
      setForm((currentForm) => ({
        ...currentForm,
        route_key: "",
      }));
      return;
    }

    setForm((currentForm) =>
      applyAssignableRouteToCargoDraft(
        {
          ...currentForm,
          origem: nextRoute.origem,
          destino: nextRoute.destino,
        },
        nextRoute,
      ),
    );
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all duration-200 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={initialData ? "Editar Carga" : "Cadastrar Nova Carga"}
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
        className="relative max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-card shadow-elevated animate-slide-up"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">
            {initialData ? "Editar Carga" : "Cadastrar Nova Carga"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Rota padrão</label>
            <select
              value={form.route_key || ""}
              onChange={(event) => handleRouteChange(event.target.value)}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="">Selecionar rota do catálogo</option>
              {selectableRoutes.map((route) => (
                <option key={route.id} value={route.route_key}>
                  {getAssignableRouteLabel(route)}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              Escolha uma rota ou apenas informe origem e destino. Quando houver coincidência, a carga recebe a rota e os valores automaticamente.
            </p>
          </div>

          {selectedRoute ? (
            <div className="rounded-2xl border border-primary/12 bg-primary/[0.04] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Rota atribuída</p>
              <h3 className="mt-2 text-sm font-semibold text-foreground">{getAssignableRouteLabel(selectedRoute)}</h3>
              <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <p>
                  Trecho:{" "}
                  <span className="font-medium text-foreground">
                    {selectedRoute.origem}
                    {" -> "}
                    {selectedRoute.destino}
                  </span>
                </p>
                <p>
                  Perfil: <span className="font-medium text-foreground">{selectedRoute.perfil_padrao || "A definir"}</span>
                </p>
                <p>
                  Valor base: <span className="font-medium text-foreground">{formatRouteMoney(selectedRoute.valor_padrao)}</span>
                </p>
                <p>
                  Bônus: <span className="font-medium text-foreground">{formatRouteMoney(selectedRoute.bonus_padrao)}</span>
                </p>
                <p>
                  Distância:{" "}
                  <span className="font-medium text-foreground">
                    {selectedRoute.distancia_km !== null ? `${selectedRoute.distancia_km} km` : "A confirmar"}
                  </span>
                </p>
                <p>
                  Tempo estimado: <span className="font-medium text-foreground">{formatRouteHours(selectedRoute.tempo_estimado_horas)}</span>
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Data/hora de carregamento</label>
              <input
                type="datetime-local"
                value={form.sheet_data_carregamento || ""}
                onChange={(event) => {
                  const next = event.target.value;
                  const [datePart, timePart] = next.split("T");
                  setForm((currentForm) => ({
                    ...currentForm,
                    sheet_data_carregamento: next,
                    data: datePart || currentForm.data,
                    horario: timePart ? timePart.slice(0, 5) : currentForm.horario,
                  }));
                }}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Data/hora de descarga</label>
              <input
                type="datetime-local"
                value={form.sheet_data_descarga || ""}
                onChange={(event) =>
                  setForm((currentForm) => ({ ...currentForm, sheet_data_descarga: event.target.value }))
                }
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Cliente</label>
            <select
              value={isClientLocked ? lockedClientId : form.cliente_id || ""}
              onChange={(event) => setForm({ ...form, cliente_id: event.target.value })}
              disabled={isClientLocked}
              className={`${inputClass} ${isClientLocked ? "cursor-not-allowed opacity-80" : "cursor-pointer"}`}
            >
              <option value="">Sem cliente vinculado</option>
              {clientes.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.nome}
                </option>
              ))}
            </select>
            {isClientLocked ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Cargas vindas da planilha online ficam vinculadas automaticamente ao cliente {lockedClientLabel || "Shopee"}.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Origem *</label>
              <input
                type="text"
                placeholder="Ex: São Paulo/SP"
                value={form.origem}
                onChange={(event) => setForm({ ...form, route_key: "", origem: event.target.value })}
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
                onChange={(event) => setForm({ ...form, route_key: "", destino: event.target.value })}
                required
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Perfil do Caminhão *</label>
              <select
                value={form.perfil}
                onChange={(event) => { hasUserEditedValuesRef.current = true; setForm({ ...form, perfil: event.target.value }); }}
                className={`${inputClass} cursor-pointer`}
              >
                {VEHICLE_PROFILE_OPTIONS.map((perfil) => (
                  <option key={perfil.value} value={perfil.value}>
                    {perfil.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Valor da carga (R$)
                {!canEditValues && <Lock className="ml-1 inline h-3 w-3 text-muted-foreground/60" />}
              </label>
              <input
                type="text"
                placeholder="Ex: 7000.00"
                value={form.valor || ""}
                onChange={(event) => { hasUserEditedValuesRef.current = true; setForm({ ...form, valor: event.target.value }); }}
                disabled={!canEditValues}
                title={!canEditValues ? "Somente operadores com acesso avançado podem alterar valores monetários" : undefined}
                className={`${inputClass} ${!canEditValues ? "cursor-not-allowed opacity-60" : ""}`}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Bônus (R$)
                {!canEditValues && <Lock className="ml-1 inline h-3 w-3 text-muted-foreground/60" />}
              </label>
              <input
                type="text"
                placeholder="Ex: 500.00"
                value={form.bonus || ""}
                onChange={(event) => { hasUserEditedValuesRef.current = true; setForm({ ...form, bonus: event.target.value }); }}
                disabled={!canEditValues}
                title={!canEditValues ? "Somente operadores com acesso avançado podem alterar valores monetários" : undefined}
                className={`${inputClass} ${!canEditValues ? "cursor-not-allowed opacity-60" : ""}`}
              />
            </div>
          </div>
          {canEditValues ? (
            <p className="-mt-1 text-xs text-muted-foreground">
              O bônus é somado ao pagamento total mostrado para o motorista.
            </p>
          ) : (
            <p className="-mt-1 flex items-center gap-1 text-xs text-amber-700">
              <Lock className="h-3 w-3 shrink-0" />
              Valor e bônus só podem ser alterados por operadores com acesso avançado.
            </p>
          )}

          <div className="admin-card-surface rounded-2xl border px-4 py-4 shadow-[0_14px_28px_-24px_hsl(223_56%_12%/0.18)]">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/70">Visibilidade no portal</p>
            <h3 className="mt-2 text-sm font-semibold text-foreground">Defina como o motorista vai receber essa carga</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Carga pública aparece na lista normal do motorista. Carga premium fica fora da tela principal e só abre pelo link direto que você compartilhar.
            </p>
            <select
              value={form.driver_visibility}
              onChange={(event) =>
                setForm({
                  ...form,
                  driver_visibility: event.target.value as CargoData["driver_visibility"],
                })
              }
              className={`${inputClass} mt-4 cursor-pointer`}
            >
              <option value={PUBLIC_VISIBILITY}>Pública (aparece no portal do motorista)</option>
              <option value={PREMIUM_VISIBILITY}>Premium (fica escondida e abre só pelo link)</option>
            </select>
            <p className="mt-3 text-xs font-medium text-muted-foreground">
              {form.driver_visibility === PREMIUM_VISIBILITY
                ? "Essa carga não vai aparecer no portal geral do motorista."
                : "Essa carga vai aparecer normalmente na listagem do motorista."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Status</label>
              <select
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value })}
                disabled={statusManagedByClaimLifecycle}
                className={`${inputClass} cursor-pointer`}
              >
                {statusManagedByClaimLifecycle ? (
                  <option value={form.status}>{form.status}</option>
                ) : null}
                <option value={DRAFT_STATUS}>Rascunho (não aparece para motorista)</option>
                <option value={OPEN_STATUS}>Aberta (aparece para motorista e aceita disputa)</option>
              </select>
            </div>
          </div>
          {statusManagedByClaimLifecycle ? (
            <p className="text-xs text-muted-foreground">
              Este status está sob controle do fluxo de disputa server-authoritative e não pode ser alterado manualmente por aqui.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Se a carga estiver aberta, ela aparece para o motorista.
          </p>
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
            className="gradient-blue cursor-pointer rounded-lg px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-blue transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated"
          >
            Salvar Carga
          </button>
        </div>
      </form>
    </div>
  );
};

export default CargoModal;

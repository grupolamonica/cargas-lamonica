import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Ban, CheckCircle2, Loader2, ShieldCheck, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { publicSupabase } from "@/integrations/supabase/public-client";
import { buildCargoPublicPath } from "@/lib/cargoLinks";
import { buildDisplayDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import {
  persistStoredLeadState,
  readStoredLeadState,
  removeStoredLeadState,
  type StoredLeadState,
} from "@/lib/driverLeadStorage";
import { fetchDriverLoadAlternatives } from "@/lib/driverLoadAlternatives";
import { cn } from "@/lib/utils";
import {
  isValidBrazilianPhone,
  isValidCpf,
  isValidPlate,
} from "@/lib/brazilianValidators";
import {
  formatVehicleProfileLabel,
  getVehicleProfileOption,
  normalizeVehicleProfile,
  type VehicleProfileValue,
} from "@/lib/vehicleProfiles";
import {
  createPublicLoadLeadPreRegistration,
  fetchLoadClaimStatus,
  type PublicLoadLeadPayload,
} from "@/services/loadClaims";

interface DriverClaimPanelProps {
  loadId: string;
  panelId?: string;
  className?: string;
}

type PreRegistrationView = "form" | "saved";

function createDefaultForm(): PublicLoadLeadPayload {
  return {
    cpf: "",
    phone: "",
    horsePlate: "",
    trailerPlate: "",
    trailerPlate2: "",
    vehicleType: "CARRETA",
  };
}

function hydrateLeadForm(form?: Partial<PublicLoadLeadPayload> | null): PublicLoadLeadPayload {
  const defaultForm = createDefaultForm();

  return {
    cpf: form?.cpf || defaultForm.cpf,
    phone: form?.phone || defaultForm.phone,
    horsePlate: form?.horsePlate || defaultForm.horsePlate,
    trailerPlate: form?.trailerPlate || defaultForm.trailerPlate,
    trailerPlate2: form?.trailerPlate2 || defaultForm.trailerPlate2,
    vehicleType: normalizeVehicleProfile(form?.vehicleType),
  };
}

function alignLeadFormToVehicleType(form: PublicLoadLeadPayload, vehicleType: VehicleProfileValue) {
  const vehicleOption = getVehicleProfileOption(vehicleType);

  return {
    ...form,
    vehicleType,
    trailerPlate: vehicleOption.trailerPlateCount >= 1 ? form.trailerPlate : "",
    trailerPlate2: vehicleOption.trailerPlateCount >= 2 ? form.trailerPlate2 : "",
  };
}

function areLeadFormsEqual(left: PublicLoadLeadPayload, right: PublicLoadLeadPayload) {
  return (
    left.cpf === right.cpf &&
    left.phone === right.phone &&
    left.horsePlate === right.horsePlate &&
    left.trailerPlate === right.trailerPlate &&
    left.trailerPlate2 === right.trailerPlate2 &&
    left.vehicleType === right.vehicleType
  );
}

function hasRequiredLeadFields(form: PublicLoadLeadPayload, vehicleType: VehicleProfileValue) {
  const alignedForm = alignLeadFormToVehicleType(form, vehicleType);
  const trailerPlateRequirement = getVehicleProfileOption(vehicleType).trailerPlateCount;

  return Boolean(
    alignedForm.cpf.trim() &&
      alignedForm.phone.trim() &&
      alignedForm.horsePlate.trim() &&
      (trailerPlateRequirement < 1 || alignedForm.trailerPlate.trim()) &&
      (trailerPlateRequirement < 2 || alignedForm.trailerPlate2.trim()) &&
      alignedForm.vehicleType.trim(),
  );
}

function getMissingRequiredLeadFields(form: PublicLoadLeadPayload, vehicleType: VehicleProfileValue) {
  const alignedForm = alignLeadFormToVehicleType(form, vehicleType);
  const missingFields: string[] = [];
  const trailerPlateRequirement = getVehicleProfileOption(vehicleType).trailerPlateCount;

  if (!alignedForm.cpf.trim()) {
    missingFields.push("CPF");
  }

  if (!alignedForm.phone.trim()) {
    missingFields.push("telefone");
  }

  if (!alignedForm.horsePlate.trim()) {
    missingFields.push("placa do cavalo");
  }

  if (trailerPlateRequirement >= 1 && !alignedForm.trailerPlate.trim()) {
    missingFields.push(trailerPlateRequirement >= 2 ? "1ª placa da carreta" : "placa da carreta");
  }

  if (trailerPlateRequirement >= 2 && !alignedForm.trailerPlate2.trim()) {
    missingFields.push("2ª placa da carreta");
  }

  return missingFields;
}

function formatMissingRequiredLeadFieldsMessage(fieldLabels: string[]) {
  if (fieldLabels.length === 0) {
    return "Preencha os campos obrigatórios para concluir sua candidatura.";
  }

  if (fieldLabels.length === 1) {
    return `Para se candidatar, preencha ${fieldLabels[0]}.`;
  }

  const initialFields = fieldLabels.slice(0, -1).join(", ");
  const lastField = fieldLabels[fieldLabels.length - 1];
  return `Para se candidatar, preencha ${initialFields} e ${lastField}.`;
}

function getInitialPreRegistrationView(state: StoredLeadState | null): PreRegistrationView {
  return state ? "saved" : "form";
}

function formatCpf(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length <= 7) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  }

  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function formatPlate(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7);
}

function formatCurrency(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function getDriverActionErrorMessage(error: unknown, fallbackMessage: string) {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const message = error.message.trim();

  if (!message) {
    return fallbackMessage;
  }

  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("unexpected error while processing the request") ||
    normalizedMessage.includes("endpoint /api/loads/") ||
    normalizedMessage.includes("nao retornou json valido") ||
    normalizedMessage.includes("respondeu sem corpo")
  ) {
    return fallbackMessage;
  }

  return message;
}

function buildTotalPayment(value: number | null, bonus: number | null) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus);

  if (!hasValue && !hasBonus) {
    return null;
  }

  return (hasValue ? value : 0) + (hasBonus ? bonus : 0);
}

function buildAlternativeEtaLabel({
  carregamentoLabel,
  data,
  horario,
}: {
  carregamentoLabel?: string | null;
  data?: string | null;
  horario?: string | null;
}) {
  const normalizedLoadingLabel = carregamentoLabel?.trim();

  if (normalizedLoadingLabel) {
    return normalizedLoadingLabel;
  }

  const normalizedDate = data?.trim() || "";
  const dateForDisplay = normalizedDate.includes("T") ? normalizedDate.slice(0, 10) : normalizedDate;

  return formatShortDateTime(buildDisplayDateTime(dateForDisplay, horario) ?? data, "A confirmar");
}

const summaryCardClassName =
  "admin-card-surface rounded-[20px] border px-3.5 py-3 shadow-[0_14px_26px_-22px_hsl(223_56%_12%/0.18)] sm:rounded-2xl sm:px-4";

const DriverClaimPanel = ({ loadId, panelId = "driver-dispute-panel", className }: DriverClaimPanelProps) => {
  const queryClient = useQueryClient();
  const initialStoredLeadState = readStoredLeadState(loadId);

  const [storedLeadState, setStoredLeadState] = useState<StoredLeadState | null>(initialStoredLeadState);
  const [form, setForm] = useState<PublicLoadLeadPayload>(hydrateLeadForm(initialStoredLeadState?.form));
  const [preRegistrationView, setPreRegistrationView] = useState<PreRegistrationView>(
    getInitialPreRegistrationView(initialStoredLeadState),
  );
  const [actionLoading, setActionLoading] = useState<"pre-register" | null>(null);

  useEffect(() => {
    const nextStoredLeadState = readStoredLeadState(loadId);
    setStoredLeadState(nextStoredLeadState);
    setForm(hydrateLeadForm(nextStoredLeadState?.form));
    setPreRegistrationView(getInitialPreRegistrationView(nextStoredLeadState));
  }, [loadId]);

  const statusQuery = useQuery({
    queryKey: ["driver", "claim-status", loadId, "public-lead", storedLeadState?.leadId ?? "anonymous"],
    queryFn: () => fetchLoadClaimStatus(loadId, undefined, storedLeadState?.leadId),
    refetchInterval: (query) => {
      if (storedLeadState?.stage !== "QUEUED") {
        return false;
      }

      const queryData = query.state.data;
      const loadStatus = queryData?.load?.status?.trim().toUpperCase() || "";
      const publicLeadStatus = queryData?.publicLead?.status?.trim().toUpperCase() || "";

      if (publicLeadStatus === "APPROVED" || publicLeadStatus === "CANCELLED") {
        return false;
      }

      return !loadStatus || loadStatus === "OPEN" ? 15_000 : false;
    },
  });

  useEffect(() => {
    const loadChannel = publicSupabase
      .channel(`driver-public-lead-${loadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "cargas", filter: `id=eq.${loadId}` }, () => {
        void queryClient.invalidateQueries({
          queryKey: ["driver", "claim-status", loadId],
          exact: false,
        });
      })
      .subscribe();

    return () => {
      publicSupabase.removeChannel(loadChannel);
    };
  }, [loadId, queryClient]);

  const load = statusQuery.data?.load ?? null;
  const claim = statusQuery.data?.claim ?? null;
  const publicLeadStatus = statusQuery.data?.publicLead?.status?.trim().toUpperCase() || "";
  const requestedVehicleType = normalizeVehicleProfile(load?.perfil);
  const requestedVehicleOption = getVehicleProfileOption(requestedVehicleType);
  const isLoadReserved = load?.status === "RESERVED" || load?.status === "BOOKED";
  const isLoadExpired = load?.status === "EXPIRED";
  const isLeadQueued = storedLeadState?.stage === "QUEUED";
  const rejectedReason = claim?.rejectedReason?.trim().toUpperCase() || "";
  const isLeadCancelledByOperator = publicLeadStatus === "CANCELLED";
  const notifiedCancelledLeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentLeadId = statusQuery.data?.publicLead?.id || storedLeadState?.leadId || null;
    if (!isLeadCancelledByOperator || !currentLeadId) {
      return;
    }
    if (notifiedCancelledLeadIdRef.current === currentLeadId) {
      return;
    }
    notifiedCancelledLeadIdRef.current = currentLeadId;
    toast.error("Sua candidatura foi cancelada pela equipe.", {
      description: "Você pode revisar seus dados e enviar uma nova candidatura se desejar.",
      duration: 8000,
    });
  }, [isLeadCancelledByOperator, statusQuery.data?.publicLead?.id, storedLeadState?.leadId]);
  const didWinLoadAllocation = publicLeadStatus === "APPROVED" && isLoadReserved;
  const didLoseLoadToAnotherDriver =
    !isLeadCancelledByOperator &&
    !didWinLoadAllocation &&
    (rejectedReason === "LOAD_BOOKED_BY_ANOTHER_DRIVER" ||
      (isLeadQueued && isLoadReserved) ||
      (isLeadQueued && isLoadExpired));
  const notifiedLostLeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentLeadId = statusQuery.data?.publicLead?.id || storedLeadState?.leadId || null;
    if (!didLoseLoadToAnotherDriver || !currentLeadId) {
      return;
    }
    if (notifiedLostLeadIdRef.current === currentLeadId) {
      return;
    }
    notifiedLostLeadIdRef.current = currentLeadId;
    toast.info(
      isLoadExpired
        ? "A carga expirou. Ela foi alocada para outro motorista."
        : "Essa carga foi alocada para outro motorista.",
      {
        description: "Busque outras cargas disponíveis na lista. Obrigado pela candidatura.",
        duration: 8000,
      },
    );
  }, [didLoseLoadToAnotherDriver, isLoadExpired, statusQuery.data?.publicLead?.id, storedLeadState?.leadId]);
  const showReservedAlert =
    !isLeadCancelledByOperator && isLoadReserved && !didLoseLoadToAnotherDriver && !didWinLoadAllocation;
  const hasSavedPreRegistration = Boolean(
    storedLeadState?.leadId &&
      hasRequiredLeadFields(hydrateLeadForm(storedLeadState.form), requestedVehicleType),
  );
  const showEditableForm = preRegistrationView === "form";
  const showSavedSummary = hasSavedPreRegistration && preRegistrationView === "saved" && !isLeadQueued;
  const currentLoadEtaLabel = buildAlternativeEtaLabel({
    carregamentoLabel: load?.carregamentoLabel,
    data: load?.data,
    horario: load?.horario,
  });

  const alternativesQuery = useQuery({
    queryKey: ["driver", "claim-alternatives", loadId, load?.origem ?? "", load?.data ?? ""],
    enabled: didLoseLoadToAnotherDriver && Boolean(load?.origem?.trim()),
    queryFn: () =>
      fetchDriverLoadAlternatives({
        loadId,
        origem: load?.origem ?? null,
        data: load?.data ?? null,
      }),
  });

  useEffect(() => {
    setForm((currentForm) => {
      const nextForm = alignLeadFormToVehicleType(currentForm, requestedVehicleType);
      return areLeadFormsEqual(currentForm, nextForm) ? currentForm : nextForm;
    });

    setStoredLeadState((currentState) => {
      if (!currentState) {
        return currentState;
      }

      const nextForm = alignLeadFormToVehicleType(hydrateLeadForm(currentState.form), requestedVehicleType);

      if (areLeadFormsEqual(nextForm, hydrateLeadForm(currentState.form))) {
        return currentState;
      }

      const nextState = {
        ...currentState,
        form: nextForm,
      };

      persistStoredLeadState(nextState);
      return nextState;
    });
  }, [requestedVehicleType]);

  const requiresFirstTrailerPlate = requestedVehicleOption.trailerPlateCount >= 1;
  const requiresSecondTrailerPlate = requestedVehicleOption.trailerPlateCount >= 2;
  const formForSubmission = alignLeadFormToVehicleType(form, requestedVehicleType);
  const missingRequiredLeadFields = getMissingRequiredLeadFields(formForSubmission, requestedVehicleType);
  const isPreRegistrationBlocked = isLoadReserved;

  const preRegistrationSummary = useMemo(() => {
    if (!storedLeadState) {
      return null;
    }

    const summaryItems = [
      { label: "CPF", value: storedLeadState.form.cpf },
      { label: "Telefone", value: storedLeadState.form.phone },
      { label: "Placa cavalo", value: storedLeadState.form.horsePlate },
    ];

    const storedVehicleOption = getVehicleProfileOption(storedLeadState.form.vehicleType);

    if (storedVehicleOption.trailerPlateCount >= 1) {
      summaryItems.push({
        label: storedVehicleOption.trailerPlateCount >= 2 ? "1ª placa da carreta" : "Placa da carreta",
        value: storedLeadState.form.trailerPlate,
      });
    }

    if (storedVehicleOption.trailerPlateCount >= 2) {
      summaryItems.push({
        label: "2ª placa da carreta",
        value: storedLeadState.form.trailerPlate2,
      });
    }

    summaryItems.push({
      label: "Tipo de veículo",
      value: formatVehicleProfileLabel(storedLeadState.form.vehicleType),
    });

    return summaryItems;
  }, [storedLeadState]);

  const syncLocalState = (nextState: StoredLeadState) => {
    const hydratedForm = alignLeadFormToVehicleType(hydrateLeadForm(nextState.form), requestedVehicleType);
    const hydratedState = {
      ...nextState,
      form: hydratedForm,
    };
    setStoredLeadState(hydratedState);
    setForm(hydratedForm);
    persistStoredLeadState(hydratedState);
  };

  const handleEditPreRegistration = () => {
    if (!hasSavedPreRegistration) {
      return;
    }

    setPreRegistrationView("form");
  };

  const handleRestartAfterCancellation = async () => {
    removeStoredLeadState(loadId);
    setStoredLeadState(null);
    setForm(createDefaultForm());
    setPreRegistrationView("form");
    await queryClient.invalidateQueries({
      queryKey: ["driver", "claim-status", loadId],
      exact: false,
    });
  };

  const handlePreRegistration = async () => {
    if (isLoadReserved) {
      toast.error("Esta carga não está mais aberta para novas candidaturas.");
      return;
    }

    if (missingRequiredLeadFields.length > 0) {
      toast.error(formatMissingRequiredLeadFieldsMessage(missingRequiredLeadFields));
      return;
    }

    if (!isValidCpf(formForSubmission.cpf)) {
      toast.error("CPF inválido. Confira os 11 dígitos.");
      return;
    }
    if (!isValidBrazilianPhone(formForSubmission.phone)) {
      toast.error("Telefone inválido. Use DDD + número (10 ou 11 dígitos).");
      return;
    }
    if (!isValidPlate(formForSubmission.horsePlate)) {
      toast.error("Placa do cavalo fora do padrão (ex.: ABC1234 ou ABC1D23).");
      return;
    }
    if (requiresFirstTrailerPlate && !isValidPlate(formForSubmission.trailerPlate)) {
      toast.error("Placa da carreta fora do padrão (ex.: ABC1234 ou ABC1D23).");
      return;
    }
    if (requiresSecondTrailerPlate && !isValidPlate(formForSubmission.trailerPlate2)) {
      toast.error("Segunda placa da carreta fora do padrão (ex.: ABC1234 ou ABC1D23).");
      return;
    }

    try {
      setActionLoading("pre-register");
      const response = await createPublicLoadLeadPreRegistration(loadId, formForSubmission);
      const nextState: StoredLeadState = {
        loadId,
        leadId: response.lead.id,
        stage: response.lead.status === "QUEUED" ? "QUEUED" : "PRE_REGISTERED",
        form: formForSubmission,
        whatsappUrl: storedLeadState?.whatsappUrl ?? null,
        updatedAt: new Date().toISOString(),
      };

      syncLocalState(nextState);
      setPreRegistrationView("saved");
      toast.success(
        response.lead.status === "QUEUED"
          ? "Candidatura enviada para a equipe."
          : "Dados da candidatura salvos com sucesso.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["driver", "claim-status", loadId],
        exact: false,
      });
    } catch (error) {
      toast.error(
        getDriverActionErrorMessage(
          error,
          "Não foi possível salvar sua candidatura agora. Tente novamente em alguns instantes.",
        ),
      );
    } finally {
      setActionLoading(null);
    }
  };

  if (statusQuery.isLoading) {
    return (
      <div
        id={panelId}
        className={cn(
          "driver-theme admin-card-surface-deep relative overflow-hidden rounded-[24px] border p-4 shadow-[0_28px_60px_-36px_hsl(223_56%_12%/0.24)] sm:rounded-[28px] sm:p-5",
          className,
        )}
      >
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Atualizando o status desta carga...
        </div>
      </div>
    );
  }

  return (
    <div
      id={panelId}
      className={cn(
        "driver-theme relative overflow-hidden rounded-[24px] border border-[hsl(223_48%_84%)] bg-[linear-gradient(180deg,hsl(220_40%_99%),hsl(220_24%_95%))] p-4 shadow-[0_28px_60px_-36px_hsl(223_56%_12%/0.24)] sm:rounded-[28px] sm:p-5",
      className,
    )}
  >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[linear-gradient(180deg,hsl(224_100%_99%),transparent)]" />
      <div className="pointer-events-none absolute right-2 top-1 h-28 w-40 rounded-full bg-[radial-gradient(circle_at_top_right,hsl(224_94%_37%/0.16),transparent_64%)] blur-2xl sm:right-8 sm:top-2 sm:h-32 sm:w-52" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="pr-12 sm:max-w-[min(100%,36rem)] sm:pr-16">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Candidatura na carga</p>
          <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Candidate-se em poucos passos
          </h3>
        </div>

        {showEditableForm ? (
          <div className="w-full sm:mr-16 sm:mt-2 sm:w-auto sm:max-w-[250px] sm:flex-shrink-0">
            <div className="admin-accent-tint relative overflow-hidden rounded-[28px] border border-primary/12 px-4 py-3.5 shadow-[0_22px_34px_-26px_hsl(224_94%_37%/0.24)] backdrop-blur-[2px]">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,hsl(224_92%_98%/0.94),transparent)]" />
              <div className="pointer-events-none absolute -right-4 -top-4 h-20 w-20 rounded-full bg-primary/10 blur-2xl" />

              <div className="relative flex items-start gap-3">
                <div className="admin-card-surface flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/10 text-primary shadow-[0_14px_24px_-18px_hsl(224_94%_37%/0.24)]">
                  <Truck className="h-5 w-5" />
                </div>

                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/60">Veículo exigido</p>
                  <p className="mt-1.5 text-base font-semibold tracking-tight text-foreground">{requestedVehicleOption.label}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{requestedVehicleOption.helperText}</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {statusQuery.error ? (
        <div className="admin-tint-danger mt-5 rounded-3xl border p-4 text-sm">
          {statusQuery.error instanceof Error ? statusQuery.error.message : "Não foi possível carregar o status desta carga."}
        </div>
      ) : null}

      {isLeadCancelledByOperator ? (
        <div className="mt-5 space-y-4">
          <div className="admin-tint-danger rounded-[22px] border p-3.5 shadow-[0_20px_36px_-28px_hsl(0_60%_40%/0.28)] sm:rounded-3xl sm:p-4">
            <div className="flex items-start gap-2.5 sm:gap-3">
              <Ban className="mt-0.5 h-4.5 w-4.5 shrink-0 text-red-700 sm:h-5 sm:w-5" />
              <div>
                <p className="text-sm font-semibold text-foreground sm:text-base">Candidatura cancelada pela equipe</p>
                <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                  A equipe cancelou sua candidatura nesta carga. Se desejar, você pode enviar uma nova candidatura.
                </p>
              </div>
            </div>
          </div>

          {preRegistrationSummary ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {preRegistrationSummary.map((item) => (
                <div
                  key={item.label}
                  className={item.label === "Tipo de veículo" ? `${summaryCardClassName} sm:col-span-2` : summaryCardClassName}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{item.label}</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">{item.value}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleRestartAfterCancellation()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent to-[hsl(155_70%_44%)] px-5 py-3 text-sm font-bold text-accent-foreground shadow-[0_4px_14px_hsl(155_70%_38%/0.3)] transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_20px_hsl(155_70%_38%/0.4)] active:translate-y-0 active:shadow-[0_2px_8px_hsl(155_70%_38%/0.3)] sm:w-auto"
            >
              <Truck className="h-4 w-4" />
              Candidatar-se novamente
            </button>
          </div>
        </div>
      ) : didWinLoadAllocation ? (
        <div className="mt-5 space-y-4">
          <div className="admin-tint-success rounded-[22px] border p-3.5 shadow-[0_20px_36px_-28px_hsl(145_60%_28%/0.32)] sm:rounded-3xl sm:p-4">
            <div className="flex items-start gap-2.5 sm:gap-3">
              <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-emerald-700 sm:h-5 sm:w-5" />
              <div>
                <p className="text-sm font-semibold text-foreground sm:text-base">
                  {load?.status === "BOOKED" ? "Carga confirmada para você" : "Carga reservada para você"}
                </p>
                <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                  A equipe liberou esta carga para você no sistema. Mesmo se ela sair da lista geral, esse retorno
                  continua salvo para você acompanhar os próximos passos.
                </p>
              </div>
            </div>
          </div>

          {preRegistrationSummary ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {preRegistrationSummary.map((item) => (
                <div
                  key={item.label}
                  className={item.label === "Tipo de veículo" ? `${summaryCardClassName} sm:col-span-2` : summaryCardClassName}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{item.label}</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">{item.value}</p>
                </div>
              ))}
            </div>
          ) : null}

          <Link
            to={`/motorista/cargas/${loadId}`}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:w-auto sm:px-5"
          >
            Abrir detalhes da carga
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : didLoseLoadToAnotherDriver ? (
        <div className="mt-5 space-y-4">
          <div className="admin-tint-warning rounded-[22px] border p-3.5 sm:rounded-3xl sm:p-4">
            <div className="flex items-start gap-2.5 sm:gap-3">
              <AlertCircle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-amber-700 sm:h-5 sm:w-5" />
              <div>
                <p className="text-sm font-semibold text-foreground sm:text-base">Esta carga seguiu com outro motorista</p>
                <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                  {alternativesQuery.data?.scope === "same-origin-eta"
                    ? `A equipe fechou esta carga com outro motorista. Para você não perder essa janela, separamos opções abertas saindo de ${load?.origem || "sua origem"} por volta de ${currentLoadEtaLabel}.`
                    : `A equipe fechou esta carga com outro motorista. Para você seguir procurando sem perder tempo, separamos outras cargas abertas saindo de ${load?.origem || "sua origem"}.`}
                </p>
              </div>
            </div>
          </div>

          <div className="admin-card-surface-deep rounded-[22px] border p-3.5 shadow-[0_16px_30px_-24px_hsl(223_56%_12%/0.16)] sm:rounded-3xl sm:p-4">
            <div className="flex items-start gap-2.5 sm:gap-3">
              <Truck className="mt-0.5 h-4.5 w-4.5 shrink-0 text-primary sm:h-5 sm:w-5" />
              <div className="w-full">
                <p className="text-sm font-semibold text-foreground sm:text-base">Outras opções saindo dessa origem</p>
                <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                  {alternativesQuery.data?.scope === "same-origin-eta"
                    ? "Estas cargas continuam abertas com a mesma origem e uma janela parecida de saída."
                    : "Estas cargas continuam abertas com a mesma origem da carga que você disputou."}
                </p>

                {alternativesQuery.isLoading ? (
                  <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Buscando outras cargas abertas nessa origem...
                  </div>
                ) : null}

                {alternativesQuery.error ? (
                  <div className="admin-tint-warning mt-4 rounded-2xl border p-3 text-sm">
                    Não consegui carregar as sugestões agora. Atualize a página para tentar novamente.
                  </div>
                ) : null}

                {!alternativesQuery.isLoading && !alternativesQuery.error && alternativesQuery.data?.items.length ? (
                  <div className="mt-4 grid gap-3 lg:grid-cols-3">
                    {alternativesQuery.data.items.map((item) => {
                      const totalPayment = buildTotalPayment(item.valor, item.bonus);

                      return (
                        <div
                          key={item.id}
                          className="admin-card-surface rounded-[20px] border p-3.5 shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.22)] sm:rounded-[24px] sm:p-4"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/60">
                            {buildAlternativeEtaLabel(item)}
                          </p>
                          <h4 className="mt-2 text-sm font-semibold leading-snug text-foreground sm:text-base">
                            {item.origem} {" → "} {item.destino}
                          </h4>
                          <p className="mt-2 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-normal">
                            {(item.clienteNome?.trim() || "Cliente a confirmar")} • {item.perfil || "Perfil a confirmar"}
                          </p>
                          <p className="mt-4 text-base font-semibold tracking-tight text-primary sm:text-lg">
                            {totalPayment !== null ? formatCurrency(totalPayment) : "A combinar"}
                          </p>
                          <Link
                            to={buildCargoPublicPath(item.id)}
                            className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary transition-colors hover:text-primary/80"
                          >
                            Abrir carga
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {!alternativesQuery.isLoading && !alternativesQuery.error && !alternativesQuery.data?.items.length ? (
                  <div className="admin-card-surface mt-4 rounded-2xl border p-3 text-sm text-muted-foreground">
                    Por enquanto não apareceu outra carga aberta saindo de {load?.origem || "sua origem"}.
                    Continue olhando a lista, porque novas oportunidades podem entrar a qualquer momento.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : showReservedAlert ? (
        <div className="mt-5 rounded-[22px] border border-amber-200 bg-amber-50 p-3.5 sm:rounded-3xl sm:p-4">
          <div className="flex items-start gap-2.5 sm:gap-3">
            <AlertCircle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-amber-700 sm:h-5 sm:w-5" />
            <div>
              <p className="text-sm font-semibold text-foreground sm:text-base">Esta carga já seguiu com outro motorista</p>
              <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                Ela já foi fechada pela equipe e deve sair da lista em instantes.
              </p>
            </div>
          </div>
        </div>
      ) : isLeadQueued && !showEditableForm ? (
        <div className="mt-5 space-y-4">
          <div className="admin-tint-success rounded-[22px] border p-3.5 shadow-[0_20px_36px_-28px_hsl(145_60%_28%/0.32)] sm:rounded-3xl sm:p-4">
            <div className="flex items-start gap-2.5 sm:gap-3">
              <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-emerald-700 sm:h-5 sm:w-5" />
              <div>
                <p className="text-sm font-semibold text-foreground sm:text-base">Sua candidatura já chegou para a equipe</p>
                <p className="mt-1 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                  Sua candidatura ficou registrada nesta carga e já entrou na fila operacional. Agora é só aguardar a
                  análise da equipe.
                </p>
              </div>
            </div>
          </div>

          {preRegistrationSummary ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {preRegistrationSummary.map((item) => (
                <div
                  key={item.label}
                  className={item.label === "Tipo de veículo" ? `${summaryCardClassName} sm:col-span-2` : summaryCardClassName}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{item.label}</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">{item.value}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleEditPreRegistration}
              className="admin-card-surface inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary/20 px-5 py-3 text-sm font-semibold text-primary shadow-[0_18px_30px_-24px_hsl(224_94%_37%/0.28)] transition-colors hover:bg-primary/[0.06] sm:w-auto"
            >
              <ShieldCheck className="h-4 w-4" />
              Atualizar meus dados
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {showEditableForm ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  type="text"
                  value={form.cpf}
                  onChange={(event) => setForm((current) => ({ ...current, cpf: formatCpf(event.target.value) }))}
                  placeholder="CPF do motorista"
                  className="admin-input-surface rounded-2xl border border-border/80 px-4 py-3 text-sm text-foreground outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                />
                <input
                  type="text"
                  value={form.phone}
                  onChange={(event) => setForm((current) => ({ ...current, phone: formatPhone(event.target.value) }))}
                  placeholder="Telefone"
                  className="admin-input-surface rounded-2xl border border-border/80 px-4 py-3 text-sm text-foreground outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                />
                <input
                  type="text"
                  value={form.horsePlate}
                  onChange={(event) => setForm((current) => ({ ...current, horsePlate: formatPlate(event.target.value) }))}
                  placeholder="Placa do cavalo"
                  className="rounded-2xl border border-border/80 bg-white px-4 py-3 text-sm uppercase text-foreground outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                />
                {requiresFirstTrailerPlate ? (
                  <input
                    type="text"
                    value={form.trailerPlate}
                    onChange={(event) => setForm((current) => ({ ...current, trailerPlate: formatPlate(event.target.value) }))}
                    placeholder={requiresSecondTrailerPlate ? "1ª placa da carreta" : "Placa da carreta"}
                    className="admin-input-surface rounded-2xl border border-border/80 px-4 py-3 text-sm uppercase text-foreground outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                  />
                ) : null}
                {requiresSecondTrailerPlate ? (
                  <input
                    type="text"
                    value={form.trailerPlate2}
                    onChange={(event) => setForm((current) => ({ ...current, trailerPlate2: formatPlate(event.target.value) }))}
                    placeholder="2ª placa da carreta"
                    className="rounded-2xl border border-border/80 bg-white px-4 py-3 text-sm uppercase text-foreground outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 md:col-span-2"
                  />
                ) : null}
                <div className="admin-tint-success rounded-2xl border px-4 py-3 shadow-[0_16px_28px_-24px_hsl(145_60%_28%/0.18)] md:col-span-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700/80">Importante</p>
                  <p className="mt-2 text-sm leading-relaxed text-foreground">
                    A candidatura não garante a carga. O operador analisa disponibilidade, perfil do veículo e ordem da fila.
                  </p>
                </div>
              </div>
            </>
          ) : null}

          {showSavedSummary && preRegistrationSummary ? (
            <div className="admin-accent-tint rounded-3xl border border-primary/18 p-4 shadow-[0_18px_34px_-28px_hsl(224_94%_37%/0.24)]">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <p className="text-base font-semibold text-foreground">Dados salvos nesta candidatura</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Seus dados ficaram prontos para esta carga. Se precisar, você pode revisar e atualizar antes da análise final.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {preRegistrationSummary.map((item) => (
                  <div
                    key={item.label}
                    className={item.label === "Tipo de veículo" ? `${summaryCardClassName} sm:col-span-2` : summaryCardClassName}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{item.label}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {showEditableForm ? (
              <button
                type="button"
                onClick={() => void handlePreRegistration()}
                disabled={isPreRegistrationBlocked || actionLoading === "pre-register"}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent to-[hsl(155_70%_44%)] px-5 py-3 text-sm font-bold text-accent-foreground shadow-[0_4px_14px_hsl(155_70%_38%/0.3)] transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_20px_hsl(155_70%_38%/0.4)] active:translate-y-0 active:shadow-[0_2px_8px_hsl(155_70%_38%/0.3)] disabled:pointer-events-none disabled:opacity-60 sm:w-auto"
              >
                {actionLoading === "pre-register" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                {hasSavedPreRegistration ? "Atualizar candidatura" : "Candidatar-se"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEditPreRegistration}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary/20 bg-primary/[0.05] px-5 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/[0.09] sm:w-auto"
              >
                <ShieldCheck className="h-4 w-4" />
                Editar candidatura
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DriverClaimPanel;

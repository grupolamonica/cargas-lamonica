import type { Tables } from "@/integrations/supabase/types";
import type { CustomBadgeItem, OperatorClientePayload } from "@/services/operatorAdmin";

export type Cliente = Tables<"clientes">;

export interface ClienteFormData {
  nome: string;
  descricao: string | null;
  logo_url: string | null;
  logo_url_card: string | null;
  logo_url_proximas: string | null;
  forma_pagamento: string | null;
  prazo_pagamento: string | null;
  exige_rastreamento: boolean;
  exige_antt: boolean;
  exige_seguro: boolean;
  exige_carga_monitorada: boolean;
  reputacao_pagamento_rapido: boolean;
  reputacao_bom_pagador: boolean;
  reputacao_liberacao_rapida: boolean;
  reputacao_carga_organizada: boolean;
  reputacao_boa_comunicacao: boolean;
  observacoes: string | null;
  custom_reputacoes: CustomBadgeItem[];
  custom_exigencias: CustomBadgeItem[];
}

const toNullableString = (value?: string | null) => {
  const trimmedValue = value?.trim() ?? "";
  return trimmedValue ? trimmedValue : null;
};

export const createEmptyClienteForm = (): ClienteFormData => ({
  nome: "",
  descricao: null,
  logo_url: null,
  logo_url_card: null,
  logo_url_proximas: null,
  forma_pagamento: null,
  prazo_pagamento: null,
  exige_rastreamento: false,
  exige_antt: false,
  exige_seguro: false,
  exige_carga_monitorada: false,
  reputacao_pagamento_rapido: false,
  reputacao_bom_pagador: false,
  reputacao_liberacao_rapida: false,
  reputacao_carga_organizada: false,
  reputacao_boa_comunicacao: false,
  observacoes: null,
  custom_reputacoes: [],
  custom_exigencias: [],
});

export const mapClienteToFormData = (cliente?: Cliente | null): ClienteFormData => {
  if (!cliente) {
    return createEmptyClienteForm();
  }

  return {
    nome: cliente.nome,
    descricao: cliente.descricao ?? null,
    logo_url: cliente.logo_url ?? null,
    logo_url_card: cliente.logo_url_card ?? null,
    logo_url_proximas: cliente.logo_url_proximas ?? null,
    forma_pagamento: cliente.forma_pagamento ?? null,
    prazo_pagamento: cliente.prazo_pagamento ?? null,
    exige_rastreamento: cliente.exige_rastreamento || Boolean(cliente.rastreamento?.trim()),
    exige_antt: cliente.exige_antt || Boolean(cliente.antt?.trim()),
    exige_seguro: cliente.exige_seguro,
    exige_carga_monitorada: cliente.exige_carga_monitorada,
    reputacao_pagamento_rapido: cliente.reputacao_pagamento_rapido,
    reputacao_bom_pagador: cliente.reputacao_bom_pagador,
    reputacao_liberacao_rapida: cliente.reputacao_liberacao_rapida,
    reputacao_carga_organizada: cliente.reputacao_carga_organizada,
    reputacao_boa_comunicacao: cliente.reputacao_boa_comunicacao,
    observacoes: cliente.observacoes ?? null,
    custom_reputacoes: (cliente.custom_reputacoes as CustomBadgeItem[] | null) ?? [],
    custom_exigencias: (cliente.custom_exigencias as CustomBadgeItem[] | null) ?? [],
  };
};

export const mapClienteFormToPayload = (form: ClienteFormData): OperatorClientePayload => ({
  nome: form.nome.trim(),
  descricao: toNullableString(form.descricao),
  logo_url: toNullableString(form.logo_url),
  logo_url_card: toNullableString(form.logo_url_card),
  logo_url_proximas: toNullableString(form.logo_url_proximas),
  forma_pagamento: toNullableString(form.forma_pagamento),
  prazo_pagamento: toNullableString(form.prazo_pagamento),
  exige_rastreamento: form.exige_rastreamento,
  exige_antt: form.exige_antt,
  exige_seguro: form.exige_seguro,
  exige_carga_monitorada: form.exige_carga_monitorada,
  reputacao_pagamento_rapido: form.reputacao_pagamento_rapido,
  reputacao_bom_pagador: form.reputacao_bom_pagador,
  reputacao_liberacao_rapida: form.reputacao_liberacao_rapida,
  reputacao_carga_organizada: form.reputacao_carga_organizada,
  reputacao_boa_comunicacao: form.reputacao_boa_comunicacao,
  observacoes: toNullableString(form.observacoes),
  custom_reputacoes: form.custom_reputacoes,
  custom_exigencias: form.custom_exigencias,
});

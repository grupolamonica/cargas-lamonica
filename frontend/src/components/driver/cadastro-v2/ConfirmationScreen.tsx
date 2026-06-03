import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, Pencil } from "lucide-react";

import { CandidaturaApiError, useCandidaturaSubmit } from "@/api/candidaturaApi";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

import { buildSubmitDados } from "./buildSubmitDados";
import { ProgressiveSection } from "./widgets/ProgressiveSection";
import { OcrResultReview, type OcrResultField } from "./widgets/OcrResultReview";
import type { StepAData } from "./steps/StepAMotorista";
import type { StepBData } from "./steps/StepBCavalo";
import type { StepCData } from "./steps/StepCProprietarioCavalo";
import type {
  CollectedCarretaOwner,
  StepDCarretaEntry,
  StepDData,
} from "./steps/StepDCarretas";
import type { StepEData } from "./steps/StepECarretaOwner";

export interface ConfirmationWizardData {
  stepA: StepAData | null;
  stepB: (StepBData & { ownerIsDriver?: boolean }) | null;
  stepC: StepCData | null;
  stepD: StepDData | null;
  stepE: Record<number, StepEData>;
  /** Owners de carretas coletados nesta sessão (PF/PJ + reuse). */
  collectedCarretaOwners: CollectedCarretaOwner[];
  /**
   * Placa do cavalo vinda do wizard (prop). Necessária quando o wizard
   * pulou o Step B (cavalo já com cadastro vigente) — o submit precisa
   * informar a placa para que o backend faça merge com o veiculo persistido.
   */
  horsePlate?: string;
  /**
   * CPF do motorista (do pré-check, só dígitos). Necessário no submit SEM
   * LOGIN quando o Step A foi pulado (motorista já conhecido → buildMotorista
   * retorna null): o backend hidrata o motorista persistido por CPF (DC-125).
   */
  cpf?: string;
}

/**
 * Contexto opcional da carga para exibir um rótulo amigável no summary card.
 * Quando ausente, o summary cai no `cargaId` cru (UUID).
 */
export interface ConfirmationCargaContext {
  origem?: string;
  destino?: string;
  routeLabel?: string;
}

export interface ConfirmationScreenProps {
  data: ConfirmationWizardData;
  cargaId: string;
  /** Origem/destino/routeLabel para exibir no summary em vez do UUID. */
  cargaContext?: ConfirmationCargaContext;
  /** Volta o wizard para `stepKey` (ex.: `step-a`); default = `step-a`. */
  onBack: (stepKey?: string) => void;
  onSuccess: (result: { protocolo: string }) => void;
  /**
   * Idempotency-Key persistido (vindo do draft). Se presente, reusa.
   * Se ausente, gera + chama `onIdempotencyKeyGenerated` para persistir.
   * Reset esperado ao trocar de carga ou após `clearAndReset`.
   */
  idempotencyKey?: string;
  /** Persistência da key recém gerada (no draft, p.ex.). */
  onIdempotencyKeyGenerated?: (key: string) => void;
  /**
   * BUG-WALK-04: avisa o wizard pai assim que o POST de submissão dispara.
   * Permite transitar o FSM para `submitting` (copy "Enviando candidatura…")
   * diferente do `loading` (pre-check "Verificando seu cadastro…").
   */
  onSubmitStart?: () => void;
  /**
   * BUG-WALK-04: avisa o wizard pai quando o submit termina em erro, para que
   * volte ao estado `confirmation` e o motorista possa retentar.
   */
  onSubmitError?: () => void;
}

const CPF_MASK = (value: string) => {
  const d = value.replace(/\D/g, "");
  if (d.length !== 11) return value;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
};

const TAG_LABELS: Record<string, string> = {
  sem_parar: "Sem Parar",
  conectcar: "ConectCar",
  move_mais: "Move Mais",
  veloe: "Veloe",
  eixo_pass: "Eixo Pass",
  nao_possuo: "Não possuo tag",
};

const PANCARY_LABELS: Record<string, string> = {
  sim: "Sim, possuo",
  nao: "Não possuo",
  desconhecido: "Não sei",
};

const CNPJ_MASK = (value: string) => {
  const d = value.replace(/\D/g, "");
  if (d.length !== 14) return value;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
};

const PHONE_MASK = (value: string) => {
  const d = value.replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value;
};

/**
 * BUG-WALK-02 — gera string de resumo ANTT para o ConfirmationScreen.
 * - Cascade SUCEDEU (rntrc presente, !requiresUpload) → "encontrada automaticamente — RNTRC NNNN"
 * - Cascade FALHOU, upload feito (rntrcFileName presente) → "arquivo enviado (nome.pdf)"
 * - Cascade FALHOU, sem upload → "não enviada"
 * - Sem dados (cascade nem rolou) → null (caller decide se omite)
 */
function buildAnttSummary(antt: {
  rntrc?: string;
  rntrcFileName?: string;
  requiresUpload?: boolean;
}): string | null {
  if (antt.rntrc && !antt.requiresUpload) {
    return `encontrada automaticamente — RNTRC ${antt.rntrc}`;
  }
  if (antt.rntrcFileName) {
    return `arquivo enviado (${antt.rntrcFileName})`;
  }
  if (antt.requiresUpload || antt.rntrc) {
    // requiresUpload sem file = pendente. rntrc presente sem cascade-ok também.
    return antt.rntrc ? `RNTRC ${antt.rntrc}` : "não enviada";
  }
  return null;
}

/**
 * 2026-05-26 — Anexa TODOS os campos do titular do RNTRC (ANTT) ao resumo,
 * pra que o motorista confira no final tudo que foi coletado das etapas
 * "Proprietário ANTT do cavalo/carreta": identidade, RNTRC, telefone,
 * endereço completo, documento/comprovante anexados e (só cavalo) banco +
 * campos sociais. `showBank` controla o bloco bancário (Lamônica paga só o
 * titular do cavalo).
 */
function appendAnttTitularFields(
  f: OcrResultField[],
  titular:
    | {
        tipo?: "pf" | "pj";
        doc?: string;
        nome?: string;
        rntrc?: string;
        telefone?: string;
        endereco?: {
          cep?: string;
          numero?: string;
          logradouro?: string;
          bairro?: string;
          cidade?: string;
          uf?: string;
          comprovanteUrl?: string;
        };
        banco?: {
          bank?: { compe?: string; nome?: string } | null;
          agencia?: string;
          conta?: string;
          tipo?: string;
        };
        pis?: string;
        estado_civil?: string;
        cor_raca?: string;
        anttOwnerDocStoragePath?: string;
        anttOwnerComprovanteStoragePath?: string;
      }
    | null
    | undefined,
  opts: { showBank: boolean },
): void {
  if (!titular || !titular.doc) return;
  f.push({
    label: "Titular do RNTRC",
    value: `${titular.nome ?? ""} — ${
      titular.tipo === "pj" ? CNPJ_MASK(titular.doc) : CPF_MASK(titular.doc)
    }`.trim(),
  });
  if (titular.rntrc) f.push({ label: "RNTRC (titular)", value: titular.rntrc });
  if (titular.telefone) {
    f.push({ label: "Telefone (titular)", value: PHONE_MASK(titular.telefone) });
  }
  const end = titular.endereco;
  if (end?.cep) f.push({ label: "CEP (titular)", value: end.cep });
  if (end?.numero) f.push({ label: "Número (titular)", value: end.numero });
  if (end?.logradouro) {
    f.push({ label: "Logradouro (titular)", value: end.logradouro });
  }
  if (end?.bairro) f.push({ label: "Bairro (titular)", value: end.bairro });
  if (end?.cidade && end?.uf) {
    f.push({ label: "Cidade / UF (titular)", value: `${end.cidade} / ${end.uf}` });
  }
  if (opts.showBank && titular.banco?.bank) {
    f.push({
      label: "Banco (titular ANTT)",
      value: `${titular.banco.bank.compe ?? ""} ${titular.banco.bank.nome ?? ""}`.trim(),
    });
    if (titular.banco.agencia) f.push({ label: "Agência", value: titular.banco.agencia });
    if (titular.banco.conta) f.push({ label: "Conta", value: titular.banco.conta });
    if (titular.banco.tipo) {
      f.push({
        label: "Tipo de conta",
        value: titular.banco.tipo === "corrente" ? "Corrente" : "Poupança",
      });
    }
  }
  if (opts.showBank && titular.pis) {
    f.push({ label: "PIS / PASEP (titular)", value: titular.pis });
  }
  if (opts.showBank && titular.estado_civil) {
    f.push({ label: "Estado civil (titular)", value: titular.estado_civil });
  }
  if (opts.showBank && titular.cor_raca) {
    f.push({ label: "Cor / raça (titular)", value: titular.cor_raca });
  }
  if (titular.anttOwnerDocStoragePath) {
    f.push({ label: "Documento do titular", value: "arquivo enviado" });
  }
  if (titular.anttOwnerComprovanteStoragePath) {
    f.push({ label: "Comprovante do titular", value: "arquivo enviado" });
  }
}

function buildMotoristaFields(stepA: StepAData | null): OcrResultField[] {
  if (!stepA?.a1) return [];
  const f: OcrResultField[] = [];
  if (stepA.a1.nome) f.push({ label: "Nome", value: stepA.a1.nome });
  if (stepA.a1.cpf) f.push({ label: "CPF", value: CPF_MASK(stepA.a1.cpf) });
  if (stepA.a1.categoria) f.push({ label: "Categoria CNH", value: stepA.a1.categoria });
  if (stepA.a1.validade) f.push({ label: "Validade CNH", value: stepA.a1.validade });
  if (stepA.a1b?.fileName) {
    f.push({ label: "Selfie com CNH", value: stepA.a1b.fileName });
  }
  if (stepA.a2?.telefone_primario) {
    f.push({ label: "Telefone", value: PHONE_MASK(stepA.a2.telefone_primario) });
  }
  if ((stepA.a2?.telefones?.length ?? 0) > 1) {
    const secundario = stepA.a2!.telefones[1];
    if (secundario) f.push({ label: "Telefone alternativo", value: PHONE_MASK(secundario) });
  }
  if (stepA.a3?.cep) f.push({ label: "CEP", value: stepA.a3.cep });
  if (stepA.a3?.numero) f.push({ label: "Número", value: stepA.a3.numero });
  if (stepA.a3?.logradouro) f.push({ label: "Endereço", value: stepA.a3.logradouro });
  if (stepA.a3?.cidade && stepA.a3.uf) {
    f.push({ label: "Cidade / UF", value: `${stepA.a3.cidade} / ${stepA.a3.uf}` });
  }
  // Tag/Pancary/Rastreador foram movidos para a seção do cavalo em 2026-05-16
  // (atributos do veículo, não do motorista).
  return f;
}

function buildCavaloFields(stepB: StepBData | null): OcrResultField[] {
  if (!stepB) return [];
  const f: OcrResultField[] = [];
  if (stepB.placa) f.push({ label: "Placa", value: stepB.placa });
  if (stepB.renavam) f.push({ label: "RENAVAM", value: stepB.renavam });
  if (stepB.chassi) f.push({ label: "Chassi", value: stepB.chassi });
  if (stepB.marca) f.push({ label: "Marca / Modelo", value: stepB.marca });
  if (stepB.ano) f.push({ label: "Ano", value: stepB.ano });
  if (stepB.cor) f.push({ label: "Cor", value: stepB.cor });
  if (stepB.ownerDoc && stepB.ownerDocType) {
    f.push({
      label: stepB.ownerDocType === "cnpj" ? "CNPJ proprietário" : "CPF proprietário",
      value: stepB.ownerDocType === "cnpj" ? CNPJ_MASK(stepB.ownerDoc) : CPF_MASK(stepB.ownerDoc),
    });
  }
  if (stepB.ownerNome) f.push({ label: "Nome proprietário", value: stepB.ownerNome });
  // Atributos do cavalo (movidos da etapa A em 2026-05-16).
  if (stepB.a4) f.push({ label: "Tag de pedágio", value: TAG_LABELS[stepB.a4] ?? stepB.a4 });
  if (stepB.a5) f.push({ label: "Pancary Pleno", value: PANCARY_LABELS[stepB.a5] ?? stepB.a5 });
  if (stepB.a6?.possui) {
    f.push({ label: "Rastreador", value: stepB.a6.possui === "sim" ? "Sim" : "Não" });
    if (stepB.a6.possui === "sim" && stepB.a6.rastreador?.empresa) {
      f.push({ label: "Empresa do rastreador", value: stepB.a6.rastreador.empresa });
    }
  }
  return f;
}

function buildOwnerCavaloFields(stepC: StepCData | null): OcrResultField[] {
  if (!stepC?.owner) return [];
  const f: OcrResultField[] = [];
  if (stepC.owner.nome) f.push({ label: "Nome", value: stepC.owner.nome });
  if (stepC.owner.documento) {
    f.push({
      label: stepC.owner.docType === "cnpj" ? "CNPJ" : "CPF",
      value:
        stepC.owner.docType === "cnpj"
          ? CNPJ_MASK(stepC.owner.documento)
          : CPF_MASK(stepC.owner.documento),
    });
  }
  // BUG-WALK-02: exibir ANTT de forma explicita no resumo expandido.
  const anttSummary = buildAnttSummary({
    rntrc: stepC.antt?.rntrc,
    rntrcFileName: stepC.antt?.rntrcFileName,
    requiresUpload: stepC.antt?.requiresUpload,
  });
  if (anttSummary) {
    f.push({ label: "ANTT", value: anttSummary });
  } else if (stepC.antt?.rntrc) {
    f.push({ label: "RNTRC", value: stepC.antt.rntrc });
  }
  // 2026-05-18 — Banco/PIS/cor/estado_civil REMOVIDOS do owner CRLV. Os
  // dados bancarios e sociais vivem em `stepC.anttTitular` (titular do RNTRC
  // do cavalo, quando difere do proprietario CRLV). Vide buildAnttTitularFields
  // no resumo da secao do cavalo.
  if (stepC.pf?.telefone) {
    f.push({ label: "Telefone", value: PHONE_MASK(stepC.pf.telefone) });
  }
  // 2026-05-26 — Inscrição estadual (PJ) e endereço do proprietário (do
  // cartão CNPJ / comprovante) no resumo.
  if (stepC.ccPJ?.isento_ie) {
    f.push({ label: "Inscrição estadual", value: "Isento" });
  } else if (stepC.ccPJ?.inscricao_estadual) {
    f.push({ label: "Inscrição estadual", value: stepC.ccPJ.inscricao_estadual });
  }
  const oe = stepC.ownerEndereco;
  if (oe?.cep) f.push({ label: "CEP", value: oe.cep });
  if (oe?.numero) f.push({ label: "Número", value: oe.numero });
  if (oe?.logradouro) f.push({ label: "Logradouro", value: oe.logradouro });
  if (oe?.cidade && oe?.uf) {
    f.push({ label: "Cidade / UF", value: `${oe.cidade} / ${oe.uf}` });
  }
  if (oe?.comprovanteUrl) f.push({ label: "Comprovante", value: "arquivo enviado" });
  // Fallback PF legado (contato avulso) quando não há ownerEndereco.
  if (!oe?.cep && stepC.pf?.cep) f.push({ label: "CEP", value: stepC.pf.cep });
  if (!oe?.numero && stepC.pf?.numero) f.push({ label: "Número", value: stepC.pf.numero });
  // 2026-05-18 refator — anttTitular agora e SEMPRE capturado (mesmo quando
  // cascade confirma que e o mesmo do CRLV). Exibe banco e campos sociais sob
  // esta secao, ja que esse e o detentor do RNTRC que Lamonica paga.
  // 2026-05-26 — agora via helper, incluindo RNTRC/telefone/endereço/docs.
  appendAnttTitularFields(f, stepC.anttTitular, { showBank: true });
  return f;
}

function buildCarretaFields(entry: StepDCarretaEntry): OcrResultField[] {
  const f: OcrResultField[] = [];
  if (entry.plate) f.push({ label: "Placa", value: entry.plate });
  if (entry.renavam) f.push({ label: "RENAVAM", value: entry.renavam });
  if (entry.chassi) f.push({ label: "Chassi", value: entry.chassi });
  if (entry.marca) f.push({ label: "Marca / Modelo", value: entry.marca });
  if (entry.ano) f.push({ label: "Ano", value: entry.ano });
  if (entry.cor) f.push({ label: "Cor", value: entry.cor });
  if (entry.owner_doc && entry.owner_doc_type) {
    f.push({
      label: entry.owner_doc_type === "cnpj" ? "CNPJ proprietário" : "CPF proprietário",
      value:
        entry.owner_doc_type === "cnpj" ? CNPJ_MASK(entry.owner_doc) : CPF_MASK(entry.owner_doc),
    });
  }
  // BUG-WALK-01 — quando o proprietário foi reusado mas a carreta tem ANTT
  // separado, exibimos o arquivo enviado para conferência. Campo opcional
  // alimentado pelo toggle "ANTT diferente desta carreta" no StepDCarretas.
  if (entry.antt_carreta_file_name) {
    f.push({
      label: "ANTT da carreta",
      value: `arquivo enviado (${entry.antt_carreta_file_name})`,
    });
  }
  return f;
}

function buildOwnerCarretaFields(stepE: StepEData | null | undefined): OcrResultField[] {
  const f: OcrResultField[] = [];
  if (!stepE) return f;
  const ownerNome = stepE.owner?.nome ?? null;
  if (ownerNome) f.push({ label: "Nome", value: ownerNome });
  const ownerDocumento = stepE.owner?.documento ?? null;
  const ownerDocType = stepE.owner?.docType ?? null;
  if (ownerDocumento) {
    f.push({
      label: ownerDocType === "cnpj" ? "CNPJ" : "CPF",
      value:
        ownerDocType === "cnpj"
          ? CNPJ_MASK(ownerDocumento)
          : CPF_MASK(ownerDocumento),
    });
  }
  // BUG-WALK-02: linha ANTT do owner de carreta (mesmo padrao do cavalo).
  const anttSummary = buildAnttSummary({
    rntrc: stepE.antt?.rntrc,
    rntrcFileName: stepE.antt?.rntrcFileName,
    requiresUpload: stepE.antt?.requiresUpload,
  });
  if (anttSummary) {
    f.push({ label: "ANTT", value: anttSummary });
  } else if (stepE.antt?.rntrc) {
    f.push({ label: "RNTRC", value: stepE.antt.rntrc });
  }
  // 2026-05-18 — Banco/PIS/cor/estado_civil REMOVIDOS do owner CRLV da carreta.
  // Lamonica nao paga o titular ANTT da carreta — apenas o do cavalo. Aqui
  // exibimos somente identidade + contato.
  if (stepE.pf?.telefone) {
    f.push({ label: "Telefone", value: PHONE_MASK(stepE.pf.telefone) });
  }
  // 2026-05-26 — IE (PJ) + endereço do proprietário (do cartão CNPJ).
  if (stepE.ccPJ?.isento_ie) {
    f.push({ label: "Inscrição estadual", value: "Isento" });
  } else if (stepE.ccPJ?.inscricao_estadual) {
    f.push({ label: "Inscrição estadual", value: stepE.ccPJ.inscricao_estadual });
  }
  const oeE = stepE.ownerEndereco;
  if (oeE?.cep) f.push({ label: "CEP", value: oeE.cep });
  if (oeE?.numero) f.push({ label: "Número", value: oeE.numero });
  if (oeE?.logradouro) f.push({ label: "Logradouro", value: oeE.logradouro });
  if (oeE?.cidade && oeE?.uf) {
    f.push({ label: "Cidade / UF", value: `${oeE.cidade} / ${oeE.uf}` });
  }
  if (oeE?.comprovanteUrl) f.push({ label: "Comprovante", value: "arquivo enviado" });
  if (!oeE?.cep && stepE.pf?.cep) f.push({ label: "CEP", value: stepE.pf.cep });
  if (!oeE?.numero && stepE.pf?.numero) f.push({ label: "Número", value: stepE.pf.numero });
  // 2026-05-18 refator — anttTitular agora e SEMPRE capturado (mesmo quando
  // cascade confirma que e o mesmo do CRLV). Exibimos a linha "Titular do
  // RNTRC" para registro explicito, mesmo se duplicar identidade do owner.
  // 2026-05-26 — agora via helper, incluindo RNTRC/telefone/endereço/docs.
  // showBank=false: Lamônica não paga o titular ANTT da carreta (só cavalo).
  appendAnttTitularFields(f, stepE.anttTitular, { showBank: false });
  return f;
}

interface EditLinkProps {
  onClick: () => void;
}
function EditLink({ onClick }: EditLinkProps) {
  return (
    <div className="pt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClick}
        className="h-9 gap-1.5 px-2 text-xs font-semibold text-primary hover:bg-primary/5"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        Editar esta etapa
      </Button>
    </div>
  );
}

/** Summary row helper: label + value, both compact for mobile. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * Constrói o rótulo amigável da carga para o summary card.
 * Preferência: routeLabel > "origem → destino" > cargaId (UUID fallback).
 */
function buildCargaLabel(
  ctx: ConfirmationCargaContext | undefined,
  cargaId: string,
): string {
  if (ctx?.routeLabel && ctx.routeLabel.trim()) return ctx.routeLabel.trim();
  const origem = ctx?.origem?.trim();
  const destino = ctx?.destino?.trim();
  if (origem && destino) return `${origem} → ${destino}`;
  if (origem) return origem;
  if (destino) return destino;
  return cargaId;
}

/**
 * Build a compact banking string for the summary card.
 *
 * 2026-05-18 — Banco vive em `stepC.anttTitular.banco` (titular ANTT do
 * cavalo). Quando o titular ANTT == owner CRLV (caso default — sem prompt),
 * o banco nao e capturado neste wizard e o summary retorna null.
 */
function buildBankingSummary(stepC: StepCData | null): string | null {
  const banco = stepC?.anttTitular?.banco;
  if (!banco?.bank) return null;
  const parts: string[] = [];
  if (banco.bank.nome) parts.push(banco.bank.nome);
  if (banco.agencia) parts.push(`Ag ${banco.agencia}`);
  if (banco.conta) parts.push(`Cc ${banco.conta}`);
  return parts.length > 0 ? parts.join(" • ") : null;
}

/**
 * Tela de confirmação final do wizard v2 (UI-SPEC §10) — Task 08-15 refactor.
 *
 * Estratégia de progressive disclosure:
 * - **Summary card sempre visível**: cargaId, nome do motorista, placas (cavalo
 *   + carreta(s)), banco/agência/conta resumido. É o resumo essencial que o
 *   motorista lê antes de confirmar.
 * - **`ProgressiveSection "Ver todos os dados"`** envolve o accordion completo
 *   (motorista, cavalo, owner, carretas, owners-carretas) com `defaultOpen=false`.
 *   Quando expandido, todos os accordions internos abrem (defaultValue=defaultOpen)
 *   permitindo edição por etapa.
 * - Checkbox de veracidade + CTA "Confirmar e enviar" continuam destacados.
 *
 * Mantém:
 * - try/catch em `buildSubmitDados` (Bug 6 mitigation Wave 1)
 * - guard `showMotorista` (Bug 5 fix Wave 1)
 * - Idempotency-Key estável por mount (W-12)
 * - admin-tint-danger callout + retry preservando dados
 * - botões grandes (min-h-[48px]) para toque mobile
 */
function ConfirmationScreenImpl({
  data,
  cargaId,
  cargaContext,
  onBack,
  onSuccess,
  idempotencyKey,
  onIdempotencyKeyGenerated,
  onSubmitStart,
  onSubmitError,
}: ConfirmationScreenProps) {
  // Reusa key persistida no draft; só gera nova se não houver.
  // Evita duplicate-submit em rede instável: re-mount após POST em vôo
  // re-envia com mesma key → servidor trata como idempotent.
  const generatedKeyRef = useRef<string | null>(null);
  const stableIdempotencyKey = useMemo(() => {
    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
    if (generatedKeyRef.current) return generatedKeyRef.current;
    const next =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `cad-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    generatedKeyRef.current = next;
    return next;
  }, [idempotencyKey]);

  // Persiste key recém gerada via callback (draft) — apenas uma vez.
  useEffect(() => {
    if (!idempotencyKey && generatedKeyRef.current && onIdempotencyKeyGenerated) {
      onIdempotencyKeyGenerated(generatedKeyRef.current);
    }
  }, [idempotencyKey, onIdempotencyKeyGenerated]);

  const submitMutation = useCandidaturaSubmit();
  const [veracityChecked, setVeracityChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const motoristaFields = buildMotoristaFields(data.stepA);
  const cavaloFields = buildCavaloFields(data.stepB);
  const ownerCavaloFields = buildOwnerCavaloFields(data.stepC);

  const carretas = data.stepD?.carretas ?? [];
  const carretaPlateLabel =
    carretas.length === 1 ? carretas[0]?.plate ?? "" : `${carretas.length} carretas`;

  // motorista só aparece se step A foi coletado nesta sessão (pode ser skipped se já cadastrado)
  const showMotorista = data.stepA !== null;
  // owner-cavalo só aparece se !ownerIsDriver e step C foi preenchido
  const showOwnerCavalo = Boolean(data.stepC && !data.stepB?.ownerIsDriver);
  const showCarretas = carretas.length > 0;

  // owners de carretas novas = entries com resolution=new
  const newCarretaOwnersData: { plate: string; stepE: StepEData }[] = [];
  carretas.forEach((carreta, idx) => {
    if (carreta.owner_resolution === "new") {
      const stepE = data.stepE[idx];
      if (stepE) newCarretaOwnersData.push({ plate: carreta.plate, stepE });
    }
  });
  const showOwnersCarretas = newCarretaOwnersData.length > 0;

  // Summary essentials -------------------------------------------------------
  const motoristaNome = data.stepA?.a1?.nome ?? null;
  const cavaloPlaca = data.stepB?.placa ?? null;
  const carretaPlacas = carretas.length > 0 ? carretas.map((c) => c.plate).join(", ") : null;
  const bankingSummary = buildBankingSummary(data.stepC);

  const handleSubmit = () => {
    if (!veracityChecked || submitMutation.isPending) return;
    setErrorMessage(null);
    let dadosClean: Record<string, unknown>;
    try {
      dadosClean = buildSubmitDados(data);
    } catch (err) {
      // N-01: stack via console.error, UI mensagem genérica caminhoneira.
      // Não vaza `err.message` cru (que pode ser "Cannot read property...").
      // eslint-disable-next-line no-console
      console.error("[ConfirmationScreen.handleSubmit] buildSubmitDados failed", err);
      setErrorMessage(
        "Deu um problema preparando os dados. Tenta fechar e abrir o cadastro de novo.",
      );
      return;
    }
    // BUG-WALK-04: avisa pai que o submit está em vôo. Pai transita FSM
    // para `submitting` (copy distinta de `loading`/pre-check).
    onSubmitStart?.();
    submitMutation.mutate(
      {
        // Cadastro standalone (sem carga): cargaId chega vazio → omite o campo
        // para o backend persistir carga_id=NULL (schema exige min(1) quando presente).
        cargaId: cargaId.trim() ? cargaId : undefined,
        dados: dadosClean,
        idempotencyKey: stableIdempotencyKey,
      },
      {
        onSuccess: (result) => {
          onSuccess({ protocolo: result.protocolo });
        },
        onError: (err) => {
          if (err instanceof CandidaturaApiError) {
            setErrorMessage(err.message);
          } else {
            setErrorMessage("Erro ao enviar a candidatura. Tente novamente.");
          }
          // Pai volta ao estado de confirmação para permitir retry.
          onSubmitError?.();
        },
      },
    );
  };

  const isSubmitting = submitMutation.isPending;

  // Default-open list calculado para quando o usuário expandir "Ver todos os dados".
  // Mantém todos os accordions abertos para facilitar edição (mesmo comportamento
  // anterior, mas escondido por padrão agora).
  const defaultOpen = useMemo(() => {
    const list: string[] = [];
    if (showMotorista) list.push("motorista");
    list.push("cavalo");
    if (showOwnerCavalo) list.push("owner-cavalo");
    if (showCarretas) list.push("carretas");
    if (showOwnersCarretas) list.push("owners-carretas");
    return list;
  }, [showMotorista, showOwnerCavalo, showCarretas, showOwnersCarretas]);

  // BUG-WALK-07: enquanto o POST está em vôo, renderiza overlay "Enviando…"
  // dentro do próprio ConfirmationScreen (em vez de mudar state.kind no
  // wizard pai). Mantém a mutation viva — o onError volta o motorista para
  // o formulário com banner de erro retryable em vez de FSM travada.
  if (isSubmitting) {
    return (
      <div
        className="driver-theme flex min-h-[260px] flex-col items-center justify-center gap-4 text-center"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
        <div className="space-y-1.5">
          <p className="text-base font-semibold text-foreground">
            Enviando sua candidatura…
          </p>
          <p className="text-sm text-muted-foreground">
            Aguarde — pode levar alguns segundos. Não feche essa tela.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="driver-theme space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          Confere se tá tudo certo
        </h2>
        <p className="text-base text-muted-foreground">
          Confere tudo. Se faltar algo, dá pra editar.
        </p>
      </header>

      {/* Summary card — resumo essencial sempre visível */}
      <section
        aria-label="Resumo do cadastro"
        className="admin-card-surface space-y-4 rounded-2xl border p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Cadastro standalone (sem carga) não exibe a linha "Carga". */}
          {cargaId.trim() ? (
            <SummaryRow label="Carga" value={buildCargaLabel(cargaContext, cargaId)} />
          ) : null}
          {motoristaNome ? (
            <SummaryRow label="Motorista" value={motoristaNome} />
          ) : null}
          {cavaloPlaca ? <SummaryRow label="Placa do cavalo" value={cavaloPlaca} /> : null}
          {carretaPlacas ? (
            <SummaryRow
              label={carretas.length === 1 ? "Placa da carreta" : "Placas das carretas"}
              value={carretaPlacas}
            />
          ) : null}
          {bankingSummary ? (
            <SummaryRow label="Conta para pagamento" value={bankingSummary} />
          ) : null}
        </div>
      </section>

      {/* Demais dados escondidos atrás de "Ver todos os dados" */}
      <ProgressiveSection
        title="Ver todos os dados"
        collapseLabel="Ocultar detalhes"
        description="Documentos, endereço, telefone e mais."
      >
        <Accordion type="multiple" defaultValue={defaultOpen} className="space-y-2">
          {showMotorista ? (
            <AccordionItem
              value="motorista"
              className="admin-card-surface rounded-2xl border px-4"
            >
              <AccordionTrigger className="text-base font-semibold">
                Seus dados de motorista
              </AccordionTrigger>
              <AccordionContent>
                <OcrResultReview fields={motoristaFields} />
                <EditLink onClick={() => onBack("step-a")} />
              </AccordionContent>
            </AccordionItem>
          ) : null}

          <AccordionItem
            value="cavalo"
            className="admin-card-surface rounded-2xl border px-4"
          >
            <AccordionTrigger className="text-base font-semibold">
              Cavalo {data.stepB?.placa ? data.stepB.placa : ""}
            </AccordionTrigger>
            <AccordionContent>
              <OcrResultReview fields={cavaloFields} />
              <EditLink onClick={() => onBack("step-b")} />
            </AccordionContent>
          </AccordionItem>

          {showOwnerCavalo ? (
            <AccordionItem
              value="owner-cavalo"
              className="admin-card-surface rounded-2xl border px-4"
            >
              <AccordionTrigger className="text-base font-semibold">
                Dono do cavalo
              </AccordionTrigger>
              <AccordionContent>
                <OcrResultReview fields={ownerCavaloFields} />
                <EditLink onClick={() => onBack("step-c")} />
              </AccordionContent>
            </AccordionItem>
          ) : null}

          {showCarretas ? (
            <AccordionItem
              value="carretas"
              className="admin-card-surface rounded-2xl border px-4"
            >
              <AccordionTrigger className="text-base font-semibold">
                {carretas.length === 1
                  ? `Carreta ${carretaPlateLabel}`
                  : `Carretas (${carretas.length})`}
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4">
                  {carretas.map((carreta) => (
                    <div key={carreta.plate} className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Carreta {carreta.plate}
                      </p>
                      <OcrResultReview fields={buildCarretaFields(carreta)} />
                    </div>
                  ))}
                </div>
                <EditLink onClick={() => onBack("step-d")} />
              </AccordionContent>
            </AccordionItem>
          ) : null}

          {showOwnersCarretas ? (
            <AccordionItem
              value="owners-carretas"
              className="admin-card-surface rounded-2xl border px-4"
            >
              <AccordionTrigger className="text-base font-semibold">
                {newCarretaOwnersData.length === 1
                  ? "Dono da carreta"
                  : "Donos das carretas"}
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4">
                  {newCarretaOwnersData.map(({ plate, stepE }) => (
                    <div key={`owner-${plate}`} className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Dono — carreta {plate}
                      </p>
                      <OcrResultReview fields={buildOwnerCarretaFields(stepE)} />
                    </div>
                  ))}
                </div>
                <EditLink onClick={() => onBack("step-e")} />
              </AccordionContent>
            </AccordionItem>
          ) : null}
        </Accordion>
      </ProgressiveSection>

      <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/30 p-4">
        <Checkbox
          id="veracity"
          checked={veracityChecked}
          onCheckedChange={(value) => setVeracityChecked(value === true)}
          className="mt-0.5 h-6 w-6"
        />
        <Label
          htmlFor="veracity"
          className="cursor-pointer text-sm font-normal leading-relaxed text-foreground"
        >
          Confiro que os dados estão certos.
        </Label>
      </div>

      {errorMessage ? (
        <div role="alert" className="admin-tint-danger rounded-2xl border p-4">
          <div className="flex items-start gap-2.5">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">
                Não rolou enviar agora. Seus dados estão salvos. Tenta de novo.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleSubmit}
                disabled={!veracityChecked || isSubmitting}
                className="min-h-[44px]"
              >
                Tentar novamente
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="cta"
          onClick={handleSubmit}
          disabled={!veracityChecked || isSubmitting}
          className="min-h-[48px] w-full py-3.5"
        >
          {isSubmitting ? "Enviando…" : "Confirmar e enviar"}
        </Button>
        {!veracityChecked && !isSubmitting ? (
          <p className="text-center text-xs text-muted-foreground">
            ↑ Marque a confirmação acima para habilitar o envio
          </p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={() => onBack()}
          disabled={isSubmitting}
          className="min-h-[48px] w-full"
        >
          Voltar
        </Button>
      </div>
    </div>
  );
}

export const ConfirmationScreen = memo(ConfirmationScreenImpl);

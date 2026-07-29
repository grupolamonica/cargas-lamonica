import { useState } from "react";
import { CheckCircle2, PartyPopper } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAttachSelfie } from "@/api/candidaturaApi";

import { StepHeader } from "../StepHeader";
import { A1bSelfie, type A1bSelfieData } from "./A1bSelfie";

/** Identidade já conhecida do cadastro aprovado/concluído (só exibição). */
export interface KnownDriverIdentity {
  nome?: string;
  cpf?: string;
}

export interface StepASelfieOnlyProps {
  /** Motorista do cadastro persistido (pre-check `persistedMotorista`). */
  knownDriver: KnownDriverIdentity;
  /** CPF (dígitos) usado na chamada attach-selfie — vem do wizard (draftCpf). */
  cpf: string;
  totalSteps: number;
  currentStep: number;
  /** Selfie já escolhida (restaura do rascunho após reload no meio do passo). */
  initialSelfie?: A1bSelfieData;
  /** Chamado após anexar a selfie com sucesso — o wizard fecha/limpa. */
  onDone: () => void;
  onBack?: () => void;
  /** Contexto p/ upload no bucket `cadastro-drafts` (slot motorista_selfie_cnh). */
  cargaId?: string;
  accessToken?: string | null;
}

function formatCpf(cpf: string | undefined): string | null {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return null;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/**
 * Etapa A no modo "só a selfie" — usada quando o pre-check devolve uma pendência
 * `reason=SELFIE_REQUIRED`: o motorista JÁ tem cadastro aprovado/concluído no
 * nosso portal, só ficou sem a selfie segurando a CNH (Step A pulado em cadastros
 * anteriores à selfie virar obrigatória, ex.: cadastro migrado de outra agência).
 *
 * Coleta SOMENTE a selfie e a anexa via POST /api/candidatura/attach-selfie — que
 * grava `selfie_cnh_url` na própria linha aprovada, SEM passar pelo submit da
 * candidatura (o claim da carga é independente; ver attach-selfie.js). Assim o
 * motorista não redigita nada, a selfie chega ao SPX, e o próximo pre-check já
 * vê hasSelfie=true (sem re-prompt).
 *
 * Componente isolado de propósito: NÃO mexe no StepAMotorista (fluxo normal
 * intacto). O DriverRegistrationWizard escolhe entre os dois.
 */
export function StepASelfieOnly({
  knownDriver,
  cpf,
  totalSteps,
  currentStep,
  initialSelfie,
  onDone,
  onBack,
  cargaId,
  accessToken,
}: StepASelfieOnlyProps) {
  const [a1bData, setA1bData] = useState<A1bSelfieData | undefined>(initialSelfie);
  const attach = useAttachSelfie();

  const cpfFormatted = formatCpf(knownDriver.cpf ?? cpf);
  // Gate no UPLOAD concluído (storageUrl), não só na escolha do arquivo — sem
  // isso o motorista poderia enviar antes do upload terminar (selfie perdida).
  const uploaded = Boolean(a1bData?.storageUrl);
  const picking = Boolean(a1bData?.fileName) && !uploaded;

  const handleContinue = () => {
    const storagePath = a1bData?.storageUrl;
    if (!storagePath) return;
    attach.mutate({ cpf: (cpf || "").replace(/\D/g, ""), selfieStoragePath: storagePath });
  };

  // Sucesso — painel próprio (o SubmissionSuccess do submit fala em "protocolo",
  // que não existe aqui). "Voltar ao portal" fecha o wizard via onDone.
  if (attach.isSuccess) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="driver-theme flex flex-col items-center gap-4 px-4 py-12 text-center"
      >
        <PartyPopper className="h-12 w-12 text-accent" aria-hidden="true" />
        <h2 className="text-2xl font-semibold tracking-tight">Selfie enviada!</h2>
        <p className="max-w-md text-base text-muted-foreground">
          Seu cadastro Lamônica agora está completo. Não precisa fazer mais nada.
        </p>
        <Button
          type="button"
          variant="cta"
          onClick={onDone}
          className="mt-4 w-full py-3.5 sm:w-auto sm:py-2.5"
        >
          Voltar ao portal
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps} - SELFIE`}
        title="Falta só a selfie com a CNH"
        description="Seu cadastro Lamônica já está completo — confira seus dados e envie a selfie segurando a CNH para finalizar."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Seu cadastro
        </p>
        <p className="mt-1 text-base font-semibold text-foreground">
          {knownDriver.nome?.trim() || "Motorista já cadastrado"}
        </p>
        {cpfFormatted ? (
          <p className="text-sm text-muted-foreground">CPF {cpfFormatted}</p>
        ) : null}
        <p className="mt-2 text-sm text-foreground/70">
          Os demais dados já estão salvos — você só precisa anexar a selfie.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <A1bSelfie
          value={a1bData}
          onChange={setA1bData}
          onValid={() => {
            /* validade real é o upload concluído (storageUrl), tratada no gate abaixo */
          }}
          cargaId={cargaId}
          cpf={cpf}
          accessToken={accessToken}
        />
        {picking ? (
          <p className="mt-2 text-sm text-muted-foreground">Enviando a foto…</p>
        ) : null}
        {uploaded ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Foto enviada.
          </p>
        ) : null}
      </div>

      {attach.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          Não foi possível anexar a selfie agora. Confira a conexão e tente de novo.
        </div>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
            Voltar
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button
          type="button"
          variant="cta"
          onClick={handleContinue}
          disabled={!uploaded || attach.isPending}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          {attach.isPending ? "Enviando…" : "Concluir"}
        </Button>
      </div>
    </div>
  );
}

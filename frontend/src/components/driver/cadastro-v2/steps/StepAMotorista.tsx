import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { isValidBrazilianPhone, isValidCpf } from "@/lib/brazilianValidators";

import { StepHeader } from "../StepHeader";
import { WizardStepCard } from "../widgets/WizardStepCard";
import { WizardStepStack } from "../widgets/WizardStepStack";
import { A1Cnh, type A1Data } from "./A1Cnh";
import { A1bSelfie, type A1bSelfieData } from "./A1bSelfie";
import { A2Telefone, type A2Data } from "./A2Telefone";
import { A3Endereco, type A3Data } from "./A3Endereco";

export interface StepADriverProfile {
  document_number: string;
  nome?: string;
  phone: string;
}

export interface StepAData {
  a1: A1Data;
  a1b: A1bSelfieData;
  a2: A2Data;
  a3: A3Data;
}

export interface StepAMotoristaProps {
  driverProfile: StepADriverProfile;
  totalSteps: number;
  currentStep: number;
  /** Dados persistidos no draft — restaura o estado de cada sub-etapa. */
  value?: StepAData;
  /**
   * Callback opcional disparado a CADA mudança em qualquer sub-etapa (A1/A1b/
   * A2/A3) — incluindo logo após OCR popular campos. Permite ao wizard
   * persistir o slice parcial no draft via debounce (500ms) e evitar que o
   * motorista perca o que extraiu se sair antes de clicar "Próximo".
   */
  onChange?: (data: Partial<StepAData>) => void;
  onComplete: (data: StepAData) => void;
  onBack?: () => void;
  /**
   * Callback opcional repassado ao A1Cnh para permitir que o motorista adote
   * o CPF/nome extraído da CNH como nova identidade da candidatura quando há
   * mismatch contra o CPF que ele usou no DriverClaimPanel.
   */
  onAdoptCnhData?: (data: { cpf: string; nome: string }) => Promise<void>;
  /**
   * Contexto p/ persistência de arquivos do draft no bucket `cadastro-drafts`.
   * Repassado às sub-etapas A1/A1b/A3 (slots: motorista_cnh, motorista_selfie_cnh,
   * motorista_comprovante). Opcional — quando ausente, upload draft é no-op.
   */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

type Validity = {
  a1: boolean;
  a1b: boolean;
  a2: boolean;
  a3: boolean;
};

// 2026-05-18 — A1c (dados pessoais + RG) deixou de ser sub-card. Os campos
// vivem inline em A1 (CNH) atrás de um ProgressiveSection colapsado por
// default. Stepper agora tem 4 cards: CNH, Selfie, Telefone, Endereço.
const SUB_KEYS = ["a1", "a1b", "a2", "a3"] as const;
type SubKey = (typeof SUB_KEYS)[number];

function formatPhoneMask(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

/**
 * Container da Etapa A — agrega as sub-etapas do motorista (A1..A3) em formato
 * stepper-accordion: somente UMA sub-etapa visível por vez, auto-colapsa ao
 * concluir, auto-expande a próxima.
 *
 * - Sub-etapas: A1 (CNH), A1b (selfie), A2 (telefone), A3 (endereço).
 * - Em 2026-05-16 as sub-etapas A4 (tag), A5 (Pancary) e A6 (rastreador) foram
 *   movidas para a Etapa B (cavalo). O payload final ainda envia-as sob
 *   `motorista` (compat. backend); o move foi só UX.
 * - Em 2026-05-18 o sub-card A1c (dados pessoais + RG) foi inlinado dentro
 *   do A1 (CNH) atrás de um ProgressiveSection colapsado por default. Os
 *   dados continuam vivendo em `A1Data` (nome_pai/rg/etc).
 * - Em submit invalido: scroll para o WizardStepCard da primeira sub-etapa
 *   invalida e re-ativa essa sub-etapa.
 */
function StepAMotoristaImpl({
  driverProfile,
  totalSteps,
  currentStep,
  value,
  onChange,
  onComplete,
  onBack,
  onAdoptCnhData,
  cargaId,
  cpf,
  accessToken,
}: StepAMotoristaProps) {
  const [a1Data, setA1Data] = useState<A1Data | undefined>(value?.a1);
  const [a1bData, setA1bData] = useState<A1bSelfieData | undefined>(value?.a1b);
  const [a2Data, setA2Data] = useState<A2Data | undefined>(value?.a2);
  const [a3Data, setA3Data] = useState<A3Data | undefined>(value?.a3);
  const [validity, setValidity] = useState<Validity>(() => ({
    a1: Boolean(value?.a1?.cpf && isValidCpf(value.a1.cpf) && value.a1.nome),
    a1b: Boolean(value?.a1b?.fileName),
    a2: Boolean(value?.a2?.telefone_primario && isValidBrazilianPhone(value.a2.telefone_primario)),
    a3: Boolean(
      value?.a3?.cep &&
        (value.a3.cep.replace(/\D/g, "").length === 8) &&
        value.a3.numero?.trim() &&
        value.a3.cidade?.trim() &&
        value.a3.uf?.trim(),
    ),
  }));

  // Hidratacao tardia do draft (fluxo publico apos F5 — GET /draft/me?cpf=XXX
  // resolve depois do mount do wizard). Re-sincroniza state interno e validity
  // quando o parent troca `value`. Guard de identidade evita loop com
  // onChange-->setStepAData no parent: so reseta quando o REF muda E o valor
  // novo difere do interno em digits-equality minima.
  //
  // BUG-FIX 2026-05-26: setA1Data(value.a1) era chamado sempre que `value` ref
  // mudava (qualquer re-render do wizard). Quando o A1Cnh interno acabou de
  // propagar dados do OCR para cima (parent.a1Data = GILSON), o ciclo de
  // re-render do wizard recriava value e essa useEffect setava a1Data de volta
  // para o conteúdo (potencialmente vazio) do draft inicial — criando loop
  // EMPTY ↔ GILSON e dados sumindo. Agora pulamos a re-sync quando o `value.a1`
  // tem nome vazio MAS o a1Data local já tem nome preenchido (OCR concluído).
  // O draft hydrate ainda funciona porque é o caso oposto (value.a1 com nome,
  // a1Data vazio).
  useEffect(() => {
    if (!value) return;
    if (value.a1 && value.a1 !== a1Data) {
      const incomingHasNome = Boolean(value.a1.nome?.trim());
      const localHasNome = Boolean(a1Data?.nome?.trim());
      const bothEmpty = !incomingHasNome && !localHasNome;
      // Só re-hidrata quando: incoming tem nome E é diferente do local.
      // bothEmpty=true: pula pra evitar loop infinito EMPTY ↔ EMPTY entre
      // useEffect [value] e useEffect [a1Data,...] (ambos disparam setState
      // com refs novas a cada render).
      // !localHasNome && incomingHasNome: hidratação inicial do draft.
      // localHasNome && !incomingHasNome: pula pra não sobrescrever OCR
      // já populado com a1Data vazio do draft.
      if (incomingHasNome && !bothEmpty) {
        setA1Data(value.a1);
      }
    }
    if (value.a1b && value.a1b !== a1bData) setA1bData(value.a1b);
    if (value.a2 && value.a2 !== a2Data) {
      const incomingPrimary = (value.a2.telefone_primario || "").replace(/\D/g, "");
      const currentPrimary = (a2Data?.telefone_primario || "").replace(/\D/g, "");
      if (incomingPrimary !== currentPrimary) setA2Data(value.a2);
    }
    if (value.a3 && value.a3 !== a3Data) {
      const incomingCep = (value.a3.cep || "").replace(/\D/g, "");
      const currentCep = (a3Data?.cep || "").replace(/\D/g, "");
      const incomingNumero = (value.a3.numero || "");
      const currentNumero = (a3Data?.numero || "");
      if (incomingCep !== currentCep || incomingNumero !== currentNumero) {
        setA3Data(value.a3);
      }
    }
    // 2026-05-26 — Removida setValidity sticky aqui. Causava oscillação:
    // setValidityFor (do A2Telefone.onValid / A3Endereco.onValid) competia
    // com este setValidity, e cada parent re-render disparava este effect
    // criando nova validity object ref, mesmo que conteúdo igual — quando
    // unicamente o sub-step interno é fonte da verdade.
    //
    // a1 sticky: apenas para hidratação tardia do draft (CNH OCR ainda
    // pendente quando value chega).
    setValidity((current) => {
      const hydratedA1 =
        current.a1 ||
        Boolean(value.a1?.cpf && isValidCpf(value.a1.cpf) && value.a1.nome);
      const hydratedA1b = current.a1b || Boolean(value.a1b?.fileName);
      if (hydratedA1 === current.a1 && hydratedA1b === current.a1b) {
        return current;
      }
      return { ...current, a1: hydratedA1, a1b: hydratedA1b };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const refs: Record<SubKey, React.RefObject<HTMLDivElement | null>> = {
    a1: useRef<HTMLDivElement | null>(null),
    a1b: useRef<HTMLDivElement | null>(null),
    a2: useRef<HTMLDivElement | null>(null),
    a3: useRef<HTMLDivElement | null>(null),
  };

  const setValidityFor = useCallback((key: SubKey, valid: boolean) => {
    setValidity((current) =>
      current[key] === valid ? current : { ...current, [key]: valid },
    );
  }, []);

  const allValid = useMemo(
    () => SUB_KEYS.every((key) => validity[key]),
    [validity],
  );

  // 2026-05-26 BUG-PISCAR: `onChange` (handleStepAProgress no wizard) muda
  // de ref a cada render do wizard porque depende de `persistSlice`, que por
  // sua vez depende de `draft`, que se rerenderiza a cada `draft.setData`.
  // Como o effect abaixo tinha `onChange` na lista de deps, virava loop
  // (~170Hz observado via MutationObserver no `a3-cep.value`):
  //   1. onChange propaga partial → wizard.setStepAData → wizard.persistSlice
  //   2. draft.setData → draft ref novo → persistSlice ref novo
  //   3. handleStepAProgress ref novo → onChange prop novo
  //   4. effect re-dispara (mesmo a1Data/a3Data sem mudar) → onChange again
  //   5. volta pra 1
  // Fix: ler `onChange` via ref. Effect só dispara quando a1Data/a3Data
  // realmente mudam.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Propaga slice parcial ao wizard sempre que qualquer sub-etapa muda.
  // Wizard persiste via debounce — garante que o que o OCR extraiu (CNH:
  // nome/cpf/categoria/validade; comprovante: cep/numero; etc.) seja salvo
  // ANTES do usuário clicar "Próximo". Sem isso, sair na tela do OCR perde
  // os campos extraídos (arquivo é restaurado, mas dados ficavam só em React).
  useEffect(() => {
    const onChangeFn = onChangeRef.current;
    if (!onChangeFn) return;
    const partial: Partial<StepAData> = {};
    // 2026-05-26: só propaga sub-etapa pro wizard quando há conteúdo
    // significativo. Antes propagava qualquer ref truthy (incluindo
    // placeholders `{nome:""}` de mount initial) — isso criava ping-pong
    // EMPTY ↔ EMPTY entre useEffect [a1Data,...] e useEffect [value],
    // já que cada call de setStepAData(empty) gerava nova ref no wizard,
    // que voltava como novo `value` prop, que via useEffect [value]
    // chamava setA1Data(empty) de novo. Cada ciclo gastava render + commit.
    // Gate por conteúdo mínimo: nome (a1), fileName (a1b), telefone (a2),
    // cep ou comprovanteUrl (a3). Empty placeholder fica local até o sub-step
    // gerar dado real (OCR ou input).
    if (a1Data && (a1Data.nome?.trim() || a1Data.storage_path)) partial.a1 = a1Data;
    if (a1bData && a1bData.fileName) partial.a1b = a1bData;
    if (a2Data && a2Data.telefone_primario) partial.a2 = a2Data;
    if (a3Data && (a3Data.cep || a3Data.comprovanteUrl)) partial.a3 = a3Data;
    if (Object.keys(partial).length > 0) {
      onChangeFn(partial);
    }
  }, [a1Data, a1bData, a2Data, a3Data]);

  // Summaries exibidos quando o card está em `completed`.
  const a1Summary = a1Data?.nome ? a1Data.nome : undefined;
  const a1bSummary = a1bData ? "Selfie enviada" : undefined;
  const a2Summary = a2Data?.telefone_primario
    ? formatPhoneMask(a2Data.telefone_primario)
    : undefined;
  const a3Summary =
    a3Data?.cidade && a3Data.uf ? `${a3Data.cidade} / ${a3Data.uf}` : undefined;

  const handleContinue = () => {
    if (!allValid) {
      const firstInvalid = SUB_KEYS.find((key) => !validity[key]);
      if (firstInvalid) {
        refs[firstInvalid].current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
      return;
    }

    if (!a1Data || !a1bData || !a2Data || !a3Data) {
      // Defesa em profundidade — se valid=true entao os dados estao preenchidos
      return;
    }

    onComplete({
      a1: a1Data,
      a1b: a1bData,
      a2: a2Data,
      a3: a3Data,
    });
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps} - SEUS DADOS`}
        title="Seus dados de motorista"
        description="Vamos confirmar o que está no seu cadastro Lamônica"
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      <WizardStepStack
        steps={[
          {
            id: "a1",
            isCompleted: validity.a1,
            render: ({ status, onActivate }) => (
              <div ref={refs.a1}>
                <WizardStepCard
                  position={1}
                  total={4}
                  title="CNH do motorista"
                  description="Envie a foto da sua CNH para preencher os dados."
                  summary={a1Summary}
                  status={status}
                  onActivate={onActivate}
                >
                  <A1Cnh
                    driverProfile={driverProfile}
                    value={a1Data}
                    onChange={setA1Data}
                    onValid={(valid) => setValidityFor("a1", valid)}
                    onAdoptCnhData={onAdoptCnhData}
                    cargaId={cargaId}
                    cpf={cpf}
                    accessToken={accessToken}
                  />
                </WizardStepCard>
              </div>
            ),
          },
          {
            id: "a1b",
            isCompleted: validity.a1b,
            render: ({ status, onActivate }) => (
              <div ref={refs.a1b}>
                <WizardStepCard
                  position={2}
                  total={4}
                  title="Selfie com a CNH"
                  description="Foto sua segurando a CNH (confirma identidade)."
                  summary={a1bSummary}
                  status={status}
                  onActivate={onActivate}
                >
                  <A1bSelfie
                    value={a1bData}
                    onChange={setA1bData}
                    onValid={(valid) => setValidityFor("a1b", valid)}
                    cargaId={cargaId}
                    cpf={cpf}
                    accessToken={accessToken}
                  />
                </WizardStepCard>
              </div>
            ),
          },
          {
            id: "a2",
            isCompleted: validity.a2,
            render: ({ status, onActivate }) => (
              <div ref={refs.a2}>
                <WizardStepCard
                  position={3}
                  total={4}
                  title="Telefone"
                  description="Confirme o número que recebe notificações da carga."
                  summary={a2Summary}
                  status={status}
                  onActivate={onActivate}
                >
                  <A2Telefone
                    driverProfile={driverProfile}
                    value={a2Data}
                    onChange={setA2Data}
                    onValid={(valid) => setValidityFor("a2", valid)}
                  />
                </WizardStepCard>
              </div>
            ),
          },
          {
            id: "a3",
            isCompleted: validity.a3,
            render: ({ status, onActivate }) => (
              <div ref={refs.a3}>
                <WizardStepCard
                  position={4}
                  total={4}
                  title="Endereço"
                  description="CEP, número e comprovante."
                  summary={a3Summary}
                  status={status}
                  onActivate={onActivate}
                >
                  <A3Endereco
                    value={a3Data}
                    onChange={setA3Data}
                    onValid={(valid) => setValidityFor("a3", valid)}
                    cargaId={cargaId}
                    cpf={cpf}
                    accessToken={accessToken}
                  />
                </WizardStepCard>
              </div>
            ),
          },
        ]}
      />

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
          disabled={!allValid}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

export const StepAMotorista = memo(StepAMotoristaImpl);

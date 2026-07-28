import { useMutation } from "@tanstack/react-query";
import { Camera, Loader2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { anexarSelfieCadastro } from "@/services/readModels";
import type { CadastroProblema } from "@/services/readModels";

/** Detecta a pendência "Selfie com a CNH não anexada" na lista de problemas. */
export function hasSelfieProblema(problemas: CadastroProblema[] | undefined): boolean {
  return (problemas ?? []).some((p) => p.area === "motorista" && /selfie/i.test(p.motivo));
}

/**
 * A partir do `dados` do cadastro: motorista existe (tem nome) mas NÃO tem a
 * selfie da CNH anexada. Usado para exibir a ação de anexar no painel do operador.
 */
export function isSelfieMissing(dados: unknown): boolean {
  if (!dados || typeof dados !== "object") return false;
  const motorista = (dados as { motorista?: unknown }).motorista;
  if (!motorista || typeof motorista !== "object") return false;
  const m = motorista as { nome?: unknown; selfie_cnh_url?: unknown };
  const temNome = typeof m.nome === "string" && m.nome.trim().length > 0;
  const temSelfie = typeof m.selfie_cnh_url === "string" && m.selfie_cnh_url.trim().length > 0;
  return temNome && !temSelfie;
}

/**
 * Botão "Anexar selfie" — o operador sobe a selfie (segurando a CNH) de um
 * cadastro que concluiu sem ela. O backend escopa a pasta pelo CPF/carga do
 * próprio cadastro. `onDone(selfieUrl)` é chamado no sucesso para o caller
 * atualizar a lista/detalhe (o cadastro sai de "Dados incompletos").
 */
export function AnexarSelfieButton({
  cadastroId,
  onDone,
  className,
}: {
  cadastroId: string;
  onDone?: (selfieUrl: string) => void;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mutation = useMutation({
    mutationFn: (file: File) => anexarSelfieCadastro(cadastroId, file),
    onSuccess: (res) => {
      toast.success("Selfie anexada. O cadastro deixa de estar incompleto.");
      onDone?.(res.selfie_cnh_url);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível anexar a selfie.");
    },
  });

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="sr-only"
        aria-label="Anexar selfie com a CNH"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // permite reescolher o mesmo arquivo
          if (file) mutation.mutate(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.click();
        }}
        className={className ?? "gap-1.5"}
      >
        {mutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Camera className="h-3.5 w-3.5" />
        )}
        Anexar selfie
      </Button>
    </>
  );
}

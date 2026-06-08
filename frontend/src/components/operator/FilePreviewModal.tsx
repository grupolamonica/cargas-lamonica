import { useQuery } from "@tanstack/react-query";
import { Loader2, ExternalLink, AlertCircle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchCadastroArquivoUrl } from "@/services/readModels";

export interface FilePreviewTarget {
  cadastroId: string;
  path: string;
  label: string;
}

interface FilePreviewModalProps {
  file: FilePreviewTarget | null;
  onClose: () => void;
}

function isPdf(path: string): boolean {
  return /\.pdf($|\?)/i.test(path);
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif)($|\?)/i.test(path);
}

/**
 * Modal de preview de um documento enviado pelo motorista. Busca uma signed URL
 * no backend (TTL 1h) e renderiza inline: imagem em <img>, PDF em <iframe>.
 * Demais tipos caem no link "abrir em nova aba".
 */
export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const open = file !== null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["operator", "cadastro-arquivo", file?.cadastroId, file?.path],
    queryFn: () => fetchCadastroArquivoUrl(file!.cadastroId, file!.path),
    enabled: open,
    staleTime: 50 * 60 * 1000, // ~50min (signed URL dura 1h)
    retry: 1,
  });

  const signedUrl = data?.signed_url ?? null;
  const path = file?.path ?? "";

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            <span className="truncate">{file?.label ?? "Arquivo"}</span>
            {signedUrl ? (
              <a
                href={signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Abrir em nova aba
              </a>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-[320px] flex items-center justify-center">
          {isLoading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Carregando arquivo…</span>
            </div>
          ) : isError || !signedUrl ? (
            <div className="flex flex-col items-center gap-2 text-destructive">
              <AlertCircle className="h-6 w-6" />
              <span className="text-sm">
                {(error as Error)?.message || "Não foi possível carregar o arquivo."}
              </span>
            </div>
          ) : isImage(path) ? (
            <img
              src={signedUrl}
              alt={file?.label ?? "documento"}
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          ) : isPdf(path) ? (
            <iframe
              title={file?.label ?? "documento"}
              src={signedUrl}
              className="h-[70vh] w-full rounded-lg border border-border"
            />
          ) : (
            <a
              href={signedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-primary/60 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <ExternalLink className="h-4 w-4" /> Abrir documento
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

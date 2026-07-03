import { useQuery } from "@tanstack/react-query";
import { Loader2, ExternalLink, AlertCircle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchCadastroArquivoUrl, fetchCadastroDocMigrado } from "@/services/readModels";

export interface FilePreviewTarget {
  cadastroId: string;
  label: string;
  /** Wizard/bucket: storage_path → signed URL. */
  path?: string;
  /** Migrado: tipo de doc → base64 do share (sem passar pelo Supabase). */
  tipo?: string;
}

interface FilePreviewModalProps {
  file: FilePreviewTarget | null;
  onClose: () => void;
}

type RenderKind = "image" | "pdf" | "other";

function kindFromName(name: string): RenderKind {
  if (/\.pdf($|\?)/i.test(name)) return "pdf";
  if (/\.(png|jpe?g|webp|gif|bmp|heic|heif)($|\?)/i.test(name)) return "image";
  return "other";
}
function kindFromMime(contentType: string): RenderKind {
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) return "image";
  return "other";
}

/**
 * Modal de preview de um documento do cadastro. Dois modos:
 *  - wizard/bucket (file.path): busca signed URL (TTL 1h) e renderiza a URL.
 *  - migrado (file.tipo): busca o doc do share como data-URI base64.
 * Imagem em <img>, PDF em <iframe>; demais tipos caem no link "abrir em nova aba".
 */
export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const open = file !== null;
  const isMigrado = !!file?.tipo;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["operator", "cadastro-doc", file?.cadastroId, file?.tipo ?? file?.path],
    queryFn: () =>
      isMigrado
        ? fetchCadastroDocMigrado(file!.cadastroId, file!.tipo!)
        : fetchCadastroArquivoUrl(file!.cadastroId, file!.path!),
    enabled: open,
    staleTime: 50 * 60 * 1000, // ~50min (signed URL dura 1h; base64 é estável)
    retry: 1,
  });

  // Normaliza os dois formatos de resposta em { src, kind }.
  let src: string | null = null;
  let kind: RenderKind = "other";
  if (data && "data_uri" in data) {
    src = data.data_uri;
    kind = kindFromMime(data.content_type || "");
    if (kind === "other") kind = kindFromName(data.filename || "");
  } else if (data && "signed_url" in data) {
    src = data.signed_url;
    kind = kindFromName(file?.path ?? "");
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            <span className="truncate">{file?.label ?? "Arquivo"}</span>
            {src ? (
              <a
                href={src}
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
          ) : isError || !src ? (
            <div className="flex flex-col items-center gap-2 text-destructive">
              <AlertCircle className="h-6 w-6" />
              <span className="text-sm">
                {(error as Error)?.message || "Não foi possível carregar o arquivo."}
              </span>
            </div>
          ) : kind === "image" ? (
            <img
              src={src}
              alt={file?.label ?? "documento"}
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          ) : kind === "pdf" ? (
            <iframe
              title={file?.label ?? "documento"}
              src={src}
              className="h-[70vh] w-full rounded-lg border border-border"
            />
          ) : (
            <a
              href={src}
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

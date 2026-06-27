import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Download, FileUp, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { formatCargoStatusLabel } from "@/lib/cargoStatus";
import {
  importOperatorCargas,
  type ImportCargasResponse,
} from "@/services/operatorAdmin";

interface ImportProgramacaoModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}

// Modelo do CSV oferecido para download (mesmas colunas aceitas pelo backend).
const TEMPLATE_HEADERS = [
  "COD. CARGA",
  "TIPO",
  "VEÍCULO",
  "DATA CARREGAMENTO",
  "DATA DESCARGA",
  "Origem",
  "Destino",
  "CLIENTE",
  "STATUS",
];

const TEMPLATE_EXAMPLE_ROWS = [
  ["LH-0012345", "Forecast", "CARRETA", "15/07/2026 08:00", "16/07/2026 18:00", "São Paulo - SP", "Rio de Janeiro - RJ", "Shopee", "rascunho"],
  ["LH-0012346", "Spot", "TRUCK", "16/07/2026 13:30", "17/07/2026 10:00", "Campinas - SP", "Belo Horizonte - MG", "", "ativa"],
];

// ';' é o separador padrão do Excel em pt-BR — o backend também aceita ','.
const CSV_DELIMITER = ";";

function csvCell(value: string) {
  return /[";,\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildTemplateCsv() {
  const lines = [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE_ROWS].map((row) => row.map(csvCell).join(CSV_DELIMITER));
  // BOM (U+FEFF) garante que o Excel abra o CSV em UTF-8 (acentos corretos).
  const bom = String.fromCharCode(0xfeff);
  return `${bom}${lines.join("\r\n")}\r\n`;
}

const ImportProgramacaoModal = ({ open, onClose, onImported }: ImportProgramacaoModalProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [csvText, setCsvText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<ImportCargasResponse | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  if (!open) return null;

  const resetState = () => {
    setCsvText("");
    setFileName("");
    setPreview(null);
    setHeaderError(null);
    setIsValidating(false);
    setIsImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = () => {
    if (isImporting) return;
    resetState();
    onClose();
  };

  const handleDownloadTemplate = () => {
    const blob = new Blob([buildTemplateCsv()], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "modelo-programacao-cargas.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setPreview(null);
    setHeaderError(null);
    setIsValidating(true);

    try {
      const text = await file.text();
      setCsvText(text);
      const response = await importOperatorCargas(text, true);
      if (!response.ok && response.headerError) {
        setHeaderError(response.headerError);
        setPreview(null);
      } else {
        setPreview(response);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao ler o arquivo CSV.");
      resetState();
    } finally {
      setIsValidating(false);
    }
  };

  const handleImport = async () => {
    if (!csvText || !preview || preview.summary.importable === 0) return;

    setIsImporting(true);
    try {
      const response = await importOperatorCargas(csvText, false);
      const { imported, duplicated, invalid } = response.summary;
      const extras = [
        duplicated > 0 ? `${duplicated} já existente(s)` : null,
        invalid > 0 ? `${invalid} com erro` : null,
      ].filter(Boolean);
      toast.success(
        `${imported} carga(s) importada(s)` + (extras.length > 0 ? ` — ${extras.join(", ")} ignorada(s).` : "."),
      );
      await onImported();
      resetState();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao importar a programação.");
    } finally {
      setIsImporting(false);
    }
  };

  const summary = preview?.summary;
  const canImport = Boolean(summary && summary.importable > 0) && !isImporting && !isValidating;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Importar programação de cargas"
        onClick={(event) => event.stopPropagation()}
        className="relative z-10 flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/80 bg-background shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-border/70 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Importar programação</h2>
            <p className="text-sm text-muted-foreground">
              Importe várias cargas de uma vez a partir de um arquivo CSV. Datas no formato dd/mm/aaaa (com hora opcional).
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isImporting}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors duration-200 hover:bg-muted disabled:opacity-50"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-2 rounded-xl border border-border/80 bg-white/90 px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted dark:bg-muted/40"
            >
              <Download className="h-4 w-4" />
              Baixar modelo CSV
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isValidating || isImporting}
              className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
            >
              {isValidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
              {isValidating ? "Validando..." : "Selecionar arquivo CSV"}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleFileChange}
            />

            {fileName ? <span className="text-sm text-muted-foreground">{fileName}</span> : null}
          </div>

          <p className="text-xs text-muted-foreground">
            Colunas: <code>{TEMPLATE_HEADERS.join(", ")}</code>. Obrigatórias: COD. CARGA, DATA CARREGAMENTO, Origem,
            Destino. O COD. CARGA é o LH — reimportar o mesmo código não duplica a carga. TIPO = tipo da viagem
            (Forecast, Spot...); VEÍCULO = CARRETA, TRUCK, etc. CLIENTE é localizado pelo nome — se não existir, a
            linha é rejeitada (deixe em branco para sem cliente).
          </p>

          {headerError ? (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{headerError}</span>
            </div>
          ) : null}

          {summary ? (
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-muted px-3 py-1 font-medium text-foreground">
                {summary.total} linha(s)
              </span>
              <span className="rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                {summary.importable} a importar
              </span>
              {summary.duplicated > 0 ? (
                <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  {summary.duplicated} já existe(m)
                </span>
              ) : null}
              {summary.invalid > 0 ? (
                <span className="rounded-full bg-red-100 px-3 py-1 font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300">
                  {summary.invalid} com erro
                </span>
              ) : null}
            </div>
          ) : null}

          {preview && preview.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-3 py-2 font-semibold">COD. CARGA</th>
                    <th className="px-3 py-2 font-semibold">Tipo</th>
                    <th className="px-3 py-2 font-semibold">Veículo</th>
                    <th className="px-3 py-2 font-semibold">Carregamento</th>
                    <th className="px-3 py-2 font-semibold">Descarga</th>
                    <th className="px-3 py-2 font-semibold">Trajeto</th>
                    <th className="px-3 py-2 font-semibold">Cliente</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Situação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {preview.rows.map((row) => (
                    <tr
                      key={row.line}
                      className={
                        !row.ok
                          ? "bg-red-50/60 dark:bg-red-500/5"
                          : row.duplicate
                            ? "bg-amber-50/60 dark:bg-amber-500/5"
                            : ""
                      }
                    >
                      <td className="px-3 py-2 text-muted-foreground">{row.line}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-medium">{row.preview.cod_carga ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{row.preview.tipo ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{row.preview.veiculo}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {row.preview.data} {row.preview.horario}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{row.preview.data_descarga ?? "—"}</td>
                      <td className="px-3 py-2">
                        {row.preview.origem} → {row.preview.destino}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{row.preview.cliente_nome ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatCargoStatusLabel(row.preview.status)}</td>
                      <td className="px-3 py-2">
                        {!row.ok ? (
                          <ul className="space-y-0.5 text-xs text-red-600 dark:text-red-400">
                            {row.errors.map((message, index) => (
                              <li key={index}>• {message}</li>
                            ))}
                          </ul>
                        ) : row.duplicate ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <Copy className="h-4 w-4" /> Já existe (será pulada)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-4 w-4" /> OK
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border/70 px-6 py-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={isImporting}
            className="cursor-pointer rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!canImport}
            className="admin-primary-button inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {isImporting ? "Importando..." : `Importar ${summary?.importable ?? 0} carga(s)`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportProgramacaoModal;

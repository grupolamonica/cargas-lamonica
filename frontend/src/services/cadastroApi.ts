// Cliente para a API local de OCR/Consultas (FastAPI em :8765).
// Vite proxy: /ocr-api/* -> http://localhost:8765/* (evita CORS).
//
// Endpoints utilizados:
//   POST /api/ocr/cnh                     { imagem }
//   POST /api/ocr/crlv                    { imagem }
//   POST /api/ocr/cartao-cnpj             { imagem }
//   POST /api/ocr/comprovante-residencia  { imagem, concessionaria }
//   POST /api/consulta/cnpj               { cnpj }
//   POST /api/consulta/cpf                { cpf, nascimento }

const BASE = "/ocr-api";

// ───────────────────── Tipos ─────────────────────

type Campo = { valor?: string };
type Section = { campos?: Record<string, Campo> };
type OcrEnvelope = {
  code: number;
  code_message?: string;
  data?: Section[];
  // Quando o backend faz auto-rename da pasta de anexos (apos extrair o
  // nome do motorista da CNH), retorna o novo id que o front deve adotar.
  id_cadastro_pasta?: string;
};
type ConsultaEnvelope = {
  code: number;
  code_message?: string;
  data?: Array<Record<string, unknown>>;
};

// ───────────────────── Helpers ─────────────────────

// Limite que o backend FastAPI aceita (config.MAX_IMAGE_BASE64_BYTES = 1.5MB).
// Mantemos 1.4MB no cliente pra ter folga depois da expansao base64.
const MAX_BASE64_BYTES = 1_400_000;
// 1200px e suficiente para EasyOCR ler comprovante/CNH/CRLV; resolucoes maiores
// quase dobram o tempo de inferencia sem ganho real de precisao.
const MAX_IMG_DIMENSION = 1200;

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler arquivo."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// Reduz a imagem ate ficar dentro de MAX_BASE64_BYTES — primeiro reduz dimensao,
// depois compressao JPEG progressiva. Mantem PDF como esta (nao da pra encolher
// trivialmente; se exceder, o backend recusa e o usuario reduz manualmente).
async function compressImage(file: File): Promise<string> {
  const dataUrlOriginal = await readAsDataUrl(file);
  if (dataUrlOriginal.length <= MAX_BASE64_BYTES * 1.33) {
    // ja esta dentro do limite (1.33 = overhead base64 -> bytes)
    return dataUrlToBase64(dataUrlOriginal);
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Falha ao decodificar imagem."));
    i.src = dataUrlOriginal;
  });

  let { width, height } = img;
  const ratio = Math.min(1, MAX_IMG_DIMENSION / Math.max(width, height));
  width = Math.round(width * ratio);
  height = Math.round(height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponivel.");
  ctx.fillStyle = "#ffffff"; // fundo branco para JPEG (sem alpha)
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.88;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  let base64 = dataUrlToBase64(dataUrl);

  // Reduz qualidade ate caber. Se ainda nao couber em 0.4, reduz dimensao.
  while (base64.length > MAX_BASE64_BYTES && quality > 0.4) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
    base64 = dataUrlToBase64(dataUrl);
  }

  if (base64.length > MAX_BASE64_BYTES) {
    // Reduz mais ainda (metade da resolucao)
    canvas.width = Math.round(width / 2);
    canvas.height = Math.round(height / 2);
    const ctx2 = canvas.getContext("2d");
    if (ctx2) {
      ctx2.fillStyle = "#ffffff";
      ctx2.fillRect(0, 0, canvas.width, canvas.height);
      ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      base64 = dataUrlToBase64(dataUrl);
    }
  }

  return base64;
}

export async function fileToBase64(file: File): Promise<string> {
  // Compressao client-side so pra imagens. PDF e outros formatos vao crus
  // (cabe ao usuario escolher um arquivo dentro do limite do backend).
  if (file.type.startsWith("image/")) {
    try {
      return await compressImage(file);
    } catch {
      // se a compressao falhar, manda o original — backend faz o gate
    }
  }
  const dataUrl = await readAsDataUrl(file);
  return dataUrlToBase64(dataUrl);
}

function ocrValor(data: Section[] | undefined, ...keys: string[]): string {
  if (!data) return "";
  for (const section of data) {
    const campos = section?.campos ?? {};
    for (const k of keys) {
      const v = campos[k]?.valor;
      if (v && typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function consultaValor(
  data: ConsultaEnvelope["data"],
  ...keys: string[]
): string {
  const row = data?.[0];
  if (!row) return "";
  for (const k of keys) {
    const v = row[k];
    if (Array.isArray(v)) {
      const first = v.map((item) => String(item).trim()).find(Boolean);
      if (first) return first;
      continue;
    }
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function consultaValores(
  data: ConsultaEnvelope["data"],
  ...keys: string[]
): string[] {
  const row = data?.[0];
  if (!row) return [];

  const values: string[] = [];
  for (const k of keys) {
    const v = row[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        const normalized = String(item).trim();
        if (normalized) values.push(normalized);
      }
      continue;
    }
    if (v != null) {
      const normalized = String(v).trim();
      if (normalized) values.push(normalized);
    }
  }
  return [...new Set(values)];
}

function composePhone(ddd: unknown, numero: unknown): string {
  const dddDigits = String(ddd ?? "").replace(/\D/g, "");
  const numeroDigits = String(numero ?? "").replace(/\D/g, "");
  if (dddDigits.length !== 2) return "";
  if (numeroDigits.length !== 8 && numeroDigits.length !== 9) return "";
  return `${dddDigits}${numeroDigits}`;
}

function extractPhones(data: ConsultaEnvelope["data"]): string[] {
  const row = data?.[0];
  if (!row) return [];

  const rawValues = [
    ...consultaValores(
      data,
      "telefone",
      "telefone_1",
      "telefone_2",
      "telefone_3",
      "celular",
      "celular_1",
      "celular_2",
    ),
    composePhone(row.ddd_telefone_1, row.telefone_1),
    composePhone(row.ddd_telefone_2, row.telefone_2),
    composePhone(row.ddd_telefone_3, row.telefone_3),
  ];

  const normalized = rawValues
    .flatMap((value) => value.split(/[/;|,\n]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const digits = value.replace(/\D/g, "");
      return (digits.length === 10 || digits.length === 11) && !/^0+$/.test(digits);
    });

  return [...new Set(normalized)];
}

// Linguagem motorista — sem mostrar "código N" nem URL técnica.
// 2026-05-21 Fase H.1: frases curtas (max ~50 chars) — motorista com baixa
// visão lê melhor frases curtas que parágrafos longos.
const OCR_GENERIC_ERROR = "Não conseguimos ler agora.";
const OCR_NETWORK_ERROR = "Deu problema do nosso lado.";
const OCR_WRONG_DOC_ERROR = "Esse não parece o documento certo.";
// DC-306: a Infosimples às vezes devolve "Link inválido" / "arquivo inválido"
// (jargão técnico do provedor de OCR) quando não consegue abrir a imagem enviada.
// O motorista via isso cru e ficava perdido — troca por uma orientação clara.
const OCR_BAD_FILE_ERROR = "Não conseguimos abrir esse arquivo. Envie outra foto (JPG ou PNG), nítida e sem corte.";

/**
 * Vocabulario tecnico que NUNCA deve chegar ao motorista. Quando detectamos
 * isso na mensagem do backend, substituimos pelo generico amigavel.
 */
const TECHNICAL_PATTERN =
  /HTTP\s*\d{3}|falha\s+na\s+requisi|timeout|fetch\s+failed|network\s*error|internal\s*server|Erro\s+\d{3,}|FastAPI|EasyOCR|OCR_\w+|Token\s+(?:de\s+autentica|invalid)|Bearer|JWT|detran-[a-z]{2}|Concessionária\s+inválida|Bucket\s+not\s+found|STORAGE_\w+|INFOSIMPLES_\w+|supabase|UPLOAD_\w+|api[_\s]error|exception|traceback|null\s*reference|undefined\s+is\s+not/i;

/**
 * Hints baseados em palavras-chave que sugerem "documento errado" — quando
 * o OCR processou OK mas nao extraiu os campos certos (ex.: motorista mandou
 * selfie no slot do CRLV).
 */
const WRONG_DOC_HINTS =
  /(?:n[aã]o\s+(?:foi\s+possivel|conseguimos)\s+extrair|sem\s+texto|extra[íi]u\s+0\b|tipo\s+de\s+documento|documento\s+(?:n[aã]o\s+reconhecido|inv[aá]lido))/i;

/**
 * DC-306 — provedor de OCR (Infosimples) não conseguiu abrir/decodificar o
 * arquivo enviado: "Link inválido", "arquivo/imagem/URL inválida", "formato não
 * suportado". Vira uma orientação de reenvio em vez do jargão cru.
 */
const BAD_FILE_HINTS =
  /(?:link|arquivo|imagem|url|foto)\s*inv[aá]lid|formato\s*(?:n[aã]o\s*suportad|inv[aá]lid)|imagem\s*corromp/i;

/**
 * Converte qualquer mensagem (front, backend, sidecar) em algo amigavel
 * para o motorista. Filtra jargao tecnico e detecta padroes de "doc errado".
 *
 * Centralizado aqui para que `extractDetail`, `ocr*` e `OcrUploadTile`
 * compartilhem a mesma logica de scrubbing.
 */
export function humanizeOcrMessage(message?: string, status?: number): string {
  if (!message) {
    return status && status >= 500 ? OCR_NETWORK_ERROR : OCR_GENERIC_ERROR;
  }
  const trimmed = String(message).trim();
  if (!trimmed) {
    return status && status >= 500 ? OCR_NETWORK_ERROR : OCR_GENERIC_ERROR;
  }
  if (TECHNICAL_PATTERN.test(trimmed)) {
    return status && status >= 500 ? OCR_NETWORK_ERROR : OCR_GENERIC_ERROR;
  }
  if (BAD_FILE_HINTS.test(trimmed)) {
    return OCR_BAD_FILE_ERROR;
  }
  if (WRONG_DOC_HINTS.test(trimmed)) {
    return OCR_WRONG_DOC_ERROR;
  }
  // Mensagem ja parece amigavel — sanity check de tamanho (> 200 chars =
  // provavelmente trace/stack disfarcado de mensagem).
  if (trimmed.length > 200) {
    return status && status >= 500 ? OCR_NETWORK_ERROR : OCR_GENERIC_ERROR;
  }
  return trimmed;
}

function extractDetail(detail: unknown, status: number): string {
  // FastAPI validation errors (4xx): mostra a primeira msg traduzida quando útil,
  // senão genérico. Server-side details podem vazar jargão técnico (Python/GPT/EasyOCR),
  // então filtramos via humanizeOcrMessage.
  if (typeof detail === "string" && detail.trim() && status < 500) {
    return humanizeOcrMessage(detail, status);
  }
  if (Array.isArray(detail) && status < 500) {
    // FastAPI validation errors: [{loc, msg, type}, ...]
    const msgs = detail
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d === "object" && "msg" in d) return String((d as { msg: unknown }).msg);
        return "";
      })
      .filter(Boolean);
    if (msgs.length) return humanizeOcrMessage(msgs[0], status);
  }
  // 5xx ou detalhe vazio → mensagem genérica
  return status >= 500 ? OCR_NETWORK_ERROR : OCR_GENERIC_ERROR;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    const msg =
      networkError instanceof Error ? networkError.message : "Sem conexao com a API.";
    throw new Error(
      `Nao foi possivel alcancar a API local (${BASE}). Confirme se ela esta rodando em http://localhost:8765. Detalhe: ${msg}`,
    );
  }

  let json: unknown = null;
  let parseErr = false;
  try {
    json = await res.json();
  } catch {
    parseErr = true;
  }

  if (!res.ok) {
    if (parseErr) throw new Error(`Falha na requisicao (HTTP ${res.status}).`);
    const detail = (json as { detail?: unknown })?.detail;
    throw new Error(extractDetail(detail, res.status));
  }

  if (parseErr) throw new Error("Resposta invalida da API (nao e JSON).");
  return json as T;
}

// ───────────────────── OCR ─────────────────────

async function ocr(path: string, imagem: string, idCadastro?: string): Promise<Section[]> {
  const json = await postJson<OcrEnvelope>(path, {
    imagem,
    ...(idCadastro ? { id_cadastro: idCadastro } : {}),
  });
  if (json.code !== 200) {
    // DC-306: humaniza a code_message do provedor (ex.: "Link inválido") — o
    // motorista via jargão cru e não sabia o que fazer.
    throw new Error(humanizeOcrMessage(json.code_message, json.code));
  }
  return json.data ?? [];
}

async function ocrEnvelope(
  path: string,
  imagem: string,
  idCadastro?: string,
): Promise<OcrEnvelope> {
  const json = await postJson<OcrEnvelope>(path, {
    imagem,
    ...(idCadastro ? { id_cadastro: idCadastro } : {}),
  });
  if (json.code !== 200) {
    throw new Error(humanizeOcrMessage(json.code_message, json.code));
  }
  return json;
}

// ───────────────────── CNH ─────────────────────

export type CnhExtracted = {
  pessoal: {
    nome: string;
    cpf: string;
    data_nascimento: string;
    nome_pai: string;
    nome_mae: string;
    naturalidade: string;
    rg: string;
    rg_orgao: string;
    rg_uf: string;
  };
  cnh: {
    registro: string;
    categoria: string;
    codigo_seguranca: string;
    numero_espelho: string;
    uf_emissor: string;
    validade: string;
    primeira_emissao: string;
  };
};

/**
 * Largura de quebra do campo `filiacao` da Infosimples. A OCR da CNH quebra
 * nomes longos numa coluna fixa (~26-27 chars) — quando uma linha atinge essa
 * largura ela está TRUNCADA e a linha seguinte é a continuação dela (quebra no
 * meio da palavra, ex. "...DOS SA" + "NTOS" = "...DOS SANTOS"). Usamos um piso
 * conservador (24) para nunca tratar um nome curto e completo como truncado.
 */
const FILIACAO_WRAP_MIN = 24;

/**
 * Reconstrói nomes quebrados em múltiplas linhas pela OCR juntando cada linha
 * de CONTINUAÇÃO à anterior. Uma linha é continuação quando a linha anterior
 * estava truncada (atingiu a wrap width) E a linha atual NÃO inicia um novo
 * nome (não é um nome completo com 2+ palavras). Continuações mono-token são o
 * caso típico ("NTOS", "ANTOS"); linhas com 2+ palavras iniciam novo nome.
 *
 * Ex.: ["FRANCISCO DE ASSIS R DOS SA"(27), "NTOS"(4),
 *       "AILANA DO CARMO SILVA DOS S"(27), "ANTOS"(5)]
 *   -> ["FRANCISCO DE ASSIS R DOS SANTOS", "AILANA DO CARMO SILVA DOS SANTOS"]
 *
 * Caso não-quebrado (linhas todas curtas, um nome completo por linha) cada
 * linha vira um nome — robusto para CNHs que já retornam pai/mãe limpos.
 */
function reconstruirNomesQuebrados(linhas: string[]): string[] {
  const nomes: string[] = [];
  let buffer = "";
  let bufferTruncado = false; // a última linha do buffer atingiu a wrap width

  const flush = () => {
    const t = buffer.trim();
    if (t) nomes.push(t);
    buffer = "";
    bufferTruncado = false;
  };

  // Um fragmento de continuação NÃO parece um nome completo: tipicamente um
  // único token (sem espaço). Linhas com 2+ palavras iniciam um novo nome,
  // mesmo após uma linha cheia (evita colar a mãe num pai longo de ~27 chars).
  const ehFragmento = (linha: string) => !/\s/.test(linha.trim());

  for (const linha of linhas) {
    if (!buffer) {
      buffer = linha;
    } else if (bufferTruncado && ehFragmento(linha)) {
      // Continuação de um nome truncado. Junta sem espaço quando a quebra foi
      // no meio da palavra (linha anterior termina em letra e atual começa em
      // letra); senão preserva o espaço do limite de palavra.
      const midWord = /[A-Za-zÀ-ÿ]$/.test(buffer) && /^[A-Za-zÀ-ÿ]/.test(linha);
      buffer += midWord ? linha : ` ${linha}`;
    } else {
      // Fim de um nome → esta linha inicia o próximo.
      flush();
      buffer = linha;
    }
    bufferTruncado = linha.length >= FILIACAO_WRAP_MIN;
  }
  flush();
  return nomes;
}

/**
 * Separa o campo `filiacao` (Infosimples) ou texto livre em {pai, mae}.
 *
 * Ordem de tentativa:
 *   1. Rótulos explícitos ("PAI:", "MÃE:", "Filiação Paterna/Materna").
 *   2. Reconstrução de nomes quebrados em múltiplas linhas (Infosimples quebra
 *      nomes longos numa largura fixa, às vezes no meio da palavra). Pai = 1º
 *      nome reconstruído, mãe = 2º (excedentes anexados à mãe).
 *   3. Fallback: se a reconstrução colapsou para 1 nome mas havia 2+ linhas
 *      cruas, usa as duas primeiras linhas cruas (degradação segura).
 *
 * Exportado para teste unitário.
 */
export function splitFiliacao(filiacao: string): { pai: string; mae: string } {
  if (!filiacao) return { pai: "", mae: "" };
  const paiLbl = filiacao.match(/(?:PAI|FILIA(?:C|Ç)AO\s+PATERNA)[\s:]+([^\n;|]+?)(?=\n|;|\||$|M[AÃ]E\b)/i);
  const maeLbl = filiacao.match(/(?:M[AÃ]E|FILIA(?:C|Ç)AO\s+MATERNA)[\s:]+([^\n;|]+)/i);
  if (paiLbl && maeLbl) return { pai: paiLbl[1].trim(), mae: maeLbl[1].trim() };

  const linhas = filiacao.split(/\n|;|\|/).map((s) => s.trim()).filter(Boolean);
  if (linhas.length === 0) return { pai: "", mae: "" };

  const nomes = reconstruirNomesQuebrados(linhas);
  if (nomes.length >= 2) {
    // Pai = 1º nome; mãe = 2º. Qualquer excedente (raro) anexa à mãe.
    return { pai: nomes[0], mae: nomes.slice(1).join(" ") };
  }
  // Reconstrução colapsou (ex. ambos os nomes vieram em 1 linha sem quebra).
  if (linhas.length >= 2) return { pai: linhas[0], mae: linhas[1] };
  return { pai: nomes[0] || "", mae: "" };
}

const UF_SET = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO",
]);

/**
 * Quebra um RG impresso em {numero, orgao, uf}. Lida com os formatos mais
 * comuns na CNH/Infosimples/Vision:
 *   - "12.345.678-9"                  -> numero apenas
 *   - "MG9014856 SSP MG"              -> numero "MG9014856", orgao "SSP", uf "MG"
 *   - "9014856 SSP/MG"                -> numero "9014856", orgao "SSP", uf "MG"
 *   - "12345678 SSP-SP"               -> numero "12345678", orgao "SSP", uf "SP"
 * Estratégia: tokeniza por espaço/barra/traço/vírgula; o último token de 2
 * letras que seja UF válida vira `uf`; tokens alfabéticos remanescentes (>=2)
 * viram `orgao`; o restante (com dígitos/X) vira `numero`.
 *
 * Exportado para teste unitário.
 */
export function splitRG(texto: string): { numero: string; orgao: string; uf: string } {
  if (!texto) return { numero: "", orgao: "", uf: "" };
  const tokens = texto
    .trim()
    .split(/[\s\-/,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length <= 1) {
    return { numero: texto.trim(), orgao: "", uf: "" };
  }

  let uf = "";
  let orgao = "";
  const numeroParts: string[] = [];

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (!uf && upper.length === 2 && UF_SET.has(upper)) {
      uf = upper;
      continue;
    }
    // Órgão = token só-letras com 2+ chars que NÃO seja UF (ex. SSP, DETRAN, PC).
    if (!orgao && /^[A-Za-z]{2,}$/.test(token)) {
      orgao = upper;
      continue;
    }
    numeroParts.push(token);
  }

  const numero = numeroParts.join(" ").trim();
  // Se não sobrou número (tudo virou orgão/uf), devolve o texto cru no numero.
  if (!numero) return { numero: texto.trim(), orgao, uf };
  return { numero, orgao, uf };
}

function splitLocal(texto: string): { cidade: string; uf: string } {
  if (!texto) return { cidade: "", uf: "" };
  const m = texto.trim().match(/^(.+?)[\s\-/,]+([A-Z]{2})\s*$/i);
  if (m) return { cidade: m[1].trim(), uf: m[2].trim().toUpperCase() };
  return { cidade: texto.trim(), uf: "" };
}

/**
 * Converte data BR (DD/MM/AAAA) para ISO (AAAA-MM-DD). Usado pelos componentes
 * cadastro-v2 que esperam o formato ISO no draft + payload final.
 */
export function brDateToIso(date: string): string {
  if (!date) return date;
  const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return date;
}

/**
 * Extrai o nº de segurança puro do campo COMBINADO `seguranca_renach` da
 * Infosimples ("<nº segurança>\n<código renach>", ex.
 * "51531458216\nMG607554835"). O nº de segurança é a parte puramente numérica;
 * o código Renach é alfanumérico ("MG607554835"). Pega o 1º token de só-dígitos
 * (ignora tokens que misturam letras). Exportado para teste unitário.
 */
export function parseSegurancaRenach(combinado: string): string {
  if (!combinado) return "";
  const tokens = combinado.split(/[\s\n;|/]+/).map((t) => t.trim()).filter(Boolean);
  // 1º token 100% dígitos = nº de segurança (descarta o Renach alfanumérico).
  const numerico = tokens.find((t) => /^\d+$/.test(t));
  return numerico ?? "";
}

/**
 * Resolve o código de segurança (nº de segurança) da CNH a partir do envelope.
 *
 * A Infosimples devolve esse dado no VERSO da CNH (`data[1]`, tipo cnh_verso) —
 * não no anverso (`data[0]`). Como `ocrValor` varre TODAS as seções, o campo
 * `seguranca` (titulo "Nº de Segurança") é alcançado normalmente.
 *
 * Aliases:
 *   - `codigo_seguranca` / `seguranca` / `numero_seguranca`: número de segurança
 *     puro (ex. "51531458216"). Preferencial.
 *   - `seguranca_renach`: campo COMBINADO "<nº segurança>\n<código renach>"
 *     (ex. "51531458216\nMG607554835"). Fallback — extraímos só a parte
 *     numérica do nº de segurança, descartando o código Renach alfanumérico.
 *     Sem isso, `digitsOnly` no backend concatenaria o nº de segurança com os
 *     dígitos do Renach (valor corrompido).
 */
function cnhCodigoSeguranca(v: (...k: string[]) => string): string {
  const direto = v("codigo_seguranca", "seguranca", "numero_seguranca");
  if (direto) return direto;
  return parseSegurancaRenach(v("seguranca_renach", "numero_seguranca_renach"));
}

export async function ocrCnh(
  file: File,
  idCadastro?: string,
): Promise<CnhExtracted & { idCadastroPasta?: string }> {
  const imagem = await fileToBase64(file);
  const env = await ocrEnvelope("/api/ocr/cnh", imagem, idCadastro);
  const data = env.data ?? [];
  const v = (...k: string[]) => ocrValor(data, ...k);

  const filiacao = splitFiliacao(v("filiacao"));
  // Vision (PROMPT_VERSION v2) já devolve rg_numero/rg_orgao/rg_uf separados.
  // Preferimos esses; fallback p/ splitRG do RG concatenado (Infosimples e
  // Vision v1 devolvem "rg" cru, às vezes UF-prefixado tipo "MG9014856 SSP MG").
  const rg = splitRG(v("identidade", "rg"));
  const rgNumero = v("rg_numero") || rg.numero;
  const rgOrgao = v("rg_orgao", "identidade_orgao") || rg.orgao;
  const rgUf = v("rg_uf", "identidade_uf") || rg.uf;
  const localCnh = splitLocal(v("local_expedicao", "local", "local_emissao"));
  const localNasc = splitLocal(v("local_nascimento", "naturalidade_local"));

  const validade = brDateToIso(v("validade", "data_validade", "vencimento"));
  let primeira =
    v("data_1_habilitacao", "primeira_habilitacao", "1_habilitacao",
      "primeira_habilitacao_data", "data_primeira_habilitacao",
      "data_emissao", "primeira_emissao", "1a_habilitacao", "habilitacao_data");
  if (primeira && validade && primeira === validade) primeira = "";

  return {
    pessoal: {
      nome: v("nome"),
      cpf: v("cpf", "numero_cpf"),
      data_nascimento: v("nascimento", "data_nascimento"),
      // Vision v2 devolve nome_pai/nome_mae diretos; fallback p/ splitFiliacao
      // do campo `filiacao` concatenado (Infosimples).
      nome_pai: v("nome_pai", "pai", "filiacao_pai") || filiacao.pai,
      nome_mae: v("nome_mae", "mae", "filiacao_mae") || filiacao.mae,
      naturalidade: v("naturalidade") || localNasc.cidade || localCnh.cidade,
      rg: rgNumero,
      rg_orgao: rgOrgao,
      rg_uf: rgUf,
    },
    cnh: {
      registro: v("registro", "numero_registro"),
      categoria: v("categoria"),
      codigo_seguranca: cnhCodigoSeguranca(v),
      numero_espelho: v("numero_espelho", "espelho"),
      uf_emissor: v("uf_emissor") || localCnh.uf || v("uf_expedicao", "uf_emissao", "estado_emissor"),
      validade,
      primeira_emissao: primeira,
    },
    idCadastroPasta: env.id_cadastro_pasta,
  };
}

// ───────────────────── CRLV ─────────────────────

export type CrlvExtracted = {
  veiculo: {
    placa: string;
    tipo: string;
    carroceria: string;
    proprietario: string;
    marca: string;
    modelo: string;
    ano_fabricacao: string;
    ano_modelo: string;
    cor: string;
    uf_emplacamento: string;
    cidade_emplacamento: string;
    renavam: string;
    chassi: string;
    eixos: string;
    antt: string;
    ultimo_licenciamento: string;
  };
  proprietario: {
    documento: string;          // CPF ou CNPJ (digits only)
    tipo: "PJ" | "PF" | "";
    nome: string;
  };
};

function splitMarcaModelo(texto: string): { marca: string; modelo: string } {
  if (!texto) return { marca: "", modelo: "" };
  const idx = texto.indexOf("/");
  if (idx > 0) return { marca: texto.slice(0, idx).trim(), modelo: texto.slice(idx + 1).trim() };
  return { marca: texto.trim(), modelo: "" };
}

export async function ocrCrlv(
  file: File,
  idCadastro?: string,
): Promise<CrlvExtracted> {
  const imagem = await fileToBase64(file);
  const data = await ocr("/api/ocr/crlv", imagem, idCadastro);

  // Debug: imprime a resposta crua da API para inspecao quando algum campo nao
  // bater com a chave esperada (Infosimples ocasionalmente muda layout).
  if (typeof window !== "undefined") {
    if (import.meta.env.DEV) console.debug("[ocrCrlv] raw response:", data);
  }

  const v = (...k: string[]) => ocrValor(data, ...k);
  const onlyDigits = (s: string) => s.replace(/\D/g, "");

  const marcaModelo = splitMarcaModelo(
    v("marca_modelo_versao", "marca_modelo", "marca", "veiculo_marca"),
  );
  const local = splitLocal(
    v("local", "municipio_uf", "local_emplacamento", "cidade_uf", "municipio_emplacamento"),
  );

  // Extracao do CPF/CNPJ do proprietario — tenta varios aliases que a Infosimples
  // pode usar dependendo da versao do produto. Resultado correto e o que tiver
  // 11 (CPF) ou 14 (CNPJ) digitos.
  const candidatos = [
    v("cnpj"),
    v("numero_cnpj"),
    v("cnpj_proprietario"),
    v("cpf"),
    v("numero_cpf"),
    v("cpf_proprietario"),
    v("cnpj_cpf_proprietario"),
    v("cpf_cnpj_proprietario"),
    v("cpf_cnpj"),
    v("documento_proprietario"),
    v("documento"),
  ].map(onlyDigits);

  const cnpjMatch = candidatos.find((d) => d.length === 14) || "";
  const cpfMatch = candidatos.find((d) => d.length === 11) || "";

  let documento = "";
  let tipo: "PJ" | "PF" | "" = "";
  if (cnpjMatch) {
    documento = cnpjMatch;
    tipo = "PJ";
  } else if (cpfMatch) {
    documento = cpfMatch;
    tipo = "PF";
  }

  return {
    veiculo: {
      placa: v("placa", "placa_veiculo"),
      tipo: v("especie_tipo", "especie", "tipo", "tipo_veiculo"),
      carroceria: v("carroceria", "tipo_carroceria"),
      proprietario: v("nome", "proprietario", "nome_proprietario", "titular"),
      marca: marcaModelo.marca || v("marca"),
      modelo: marcaModelo.modelo || v("modelo"),
      ano_fabricacao: v("ano_fabricacao", "ano_fabricacao_veiculo"),
      ano_modelo: v("ano_modelo", "ano_modelo_veiculo"),
      cor: v("cor_predominante", "cor", "cor_veiculo"),
      uf_emplacamento: local.uf || v("uf_emplacamento", "uf"),
      cidade_emplacamento: local.cidade || v("municipio", "cidade_emplacamento", "cidade"),
      renavam: v("renavam"),
      chassi: v("chassi"),
      eixos: v("eixos", "quantidade_eixos", "numero_eixos"),
      antt: v(
        "antt",
        "rntrc",
        "numero_antt",
        "numero_rntrc",
        "registro_rntrc",
        "rntrc_numero",
        "antt_rntrc",
        "registro_antt",
      ),
      ultimo_licenciamento: v(
        "preencher_campo_data",
        "data_assinatura",
        "data_licenciamento",
        "data_ultimo_licenciamento",
        "assinatura_data",
        "data_licenciamento_crlv",
        "data",
        "data_emissao",
        "ultimo_licenciamento",
      ),
    },
    proprietario: {
      documento,
      tipo,
      nome: v("nome", "proprietario", "nome_proprietario", "titular"),
    },
  };
}

// ───────────────────── Cartão CNPJ (OCR) ─────────────────────

export type CartaoCnpjExtracted = {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string;
  cep: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
  numero: string;
};

export async function ocrCartaoCnpj(file: File): Promise<CartaoCnpjExtracted> {
  const imagem = await fileToBase64(file);
  const data = await ocr("/api/ocr/cartao-cnpj", imagem);
  const v = (...k: string[]) => ocrValor(data, ...k);

  return {
    cnpj: v("cnpj", "numero_cnpj"),
    razao_social: v("razao_social", "nome_empresarial", "nome"),
    nome_fantasia: v("nome_fantasia"),
    cep: v("cep", "numero_cep"),
    uf: v("uf"),
    cidade: v("municipio", "cidade"),
    bairro: v("bairro"),
    logradouro: v("logradouro", "endereco"),
    numero: v("numero", "numero_endereco"),
  };
}

// ───────────────────── Comprovante de residência ─────────────────────

export type ComprovanteExtracted = {
  cep: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
  numero: string;
};

export const CONCESSIONARIAS = [
  "cpfl",
  "enel",
  "cemig",
  "light",
  "energisa",
  "neoenergia",
  "rge",
  "elektro",
] as const;

export type Concessionaria = (typeof CONCESSIONARIAS)[number];

export async function ocrComprovante(
  file: File,
  concessionaria: Concessionaria = "neoenergia",
  idCadastro?: string,
): Promise<ComprovanteExtracted> {
  const imagem = await fileToBase64(file);
  const json = await postJson<OcrEnvelope>("/api/ocr/comprovante-residencia", {
    imagem,
    concessionaria,
    ...(idCadastro ? { id_cadastro: idCadastro } : {}),
  });
  if (json.code !== 200) {
    throw new Error(humanizeOcrMessage(json.code_message, json.code));
  }
  const data = json.data ?? [];
  const v = (...k: string[]) => ocrValor(data, ...k);
  const local = splitLocal(v("municipio_uf", "cidade_uf"));

  return {
    cep: v("cep", "numero_cep"),
    uf: local.uf || v("uf"),
    cidade: local.cidade || v("municipio", "cidade"),
    bairro: v("bairro"),
    logradouro: v("logradouro", "endereco", "rua"),
    numero: v("numero", "numero_endereco"),
  };
}

// ───────────────────── Consulta ANTT (RNTRC do veiculo) ─────────────────────

export type AnttStatus = {
  rntrc: string;
  situacao: string;
  vencimento: string;
  transportador: string;
  cnpj_transportador: string;
  tipo_transportador: string;
  ok: boolean;            // true se situacao for regular/ativa
  found: boolean;         // true se a Infosimples retornou dados
  rawCode: number;
  rawMessage: string;
};

export async function consultaAnttVeiculo(opts: {
  rntrc?: string;
  cnpj?: string;
  cpf?: string;
  placa?: string;
}): Promise<AnttStatus> {
  // Estrategia em fallback (espelha o site consultapublica.antt.gov.br):
  //   1. RNTRC                -> /api/consulta/antt {rntrc}        (antt/transportador)
  //   2. CNPJ (ETC/CTC)       -> /api/consulta/antt {cnpj}         (antt/transportador)
  //   3. CPF (TAC)            -> /api/consulta/antt {cpf}          (antt/transportador)
  //   4. Placa + CPF/CNPJ     -> /api/consulta/antt-veiculo {placa, cpf?, cnpj?}
  //                              (tenta varios produtos no backend)
  const rntrc = (opts.rntrc ?? "").replace(/\D/g, "");
  const cnpj = (opts.cnpj ?? "").replace(/\D/g, "");
  const cpf = (opts.cpf ?? "").replace(/\D/g, "");
  const placa = (opts.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  let json: ConsultaEnvelope;
  let estrategia: "rntrc" | "cnpj" | "cpf" | "placa";

  if (rntrc) {
    estrategia = "rntrc";
    json = await postJson<ConsultaEnvelope>("/api/consulta/antt", { rntrc });
  } else if (cnpj.length === 14) {
    estrategia = "cnpj";
    json = await postJson<ConsultaEnvelope>("/api/consulta/antt", { cnpj });
  } else if (cpf.length === 11) {
    estrategia = "cpf";
    json = await postJson<ConsultaEnvelope>("/api/consulta/antt", { cpf });
  } else if (placa.length === 7) {
    estrategia = "placa";
    json = await postJson<ConsultaEnvelope>("/api/consulta/antt-veiculo", {
      placa,
      cpf: cpf || undefined,
      cnpj: cnpj || undefined,
    });
  } else {
    throw new Error("Informe ao menos RNTRC, CNPJ, CPF ou placa valida.");
  }

  const rawCode = json.code ?? 0;
  const rawMessage = json.code_message ?? "";

  if (typeof window !== "undefined") {
    if (import.meta.env.DEV) console.debug(`[consultaAntt/${estrategia}] raw response:`, { code: rawCode, data: json.data });
  }

  // Codigos Infosimples comuns:
  //   200 → dados encontrados
  //   612 → registro nao localizado
  //   605 → parametros obrigatorios ausentes (config do produto)
  if (rawCode !== 200) {
    return {
      rntrc: rntrc || "",
      situacao: "",
      vencimento: "",
      transportador: "",
      cnpj_transportador: "",
      tipo_transportador: "",
      ok: false,
      found: false,
      rawCode,
      rawMessage,
    };
  }

  const v = (...keys: string[]) => consultaValor(json.data, ...keys);

  const situacao = v(
    "situacao",
    "situacao_rntrc",
    "situacao_registro",
    "status",
    "situacao_atual",
  );
  const vencimento = v(
    "vencimento",
    "data_validade",
    "validade",
    "data_vencimento",
    "data_vencimento_registro",
  );
  const transportador = v(
    "transportador",
    "razao_social",
    "nome",
    "nome_transportador",
    "razao_social_transportador",
  );
  const cnpjTransp = v("cnpj", "numero_cnpj", "cnpj_transportador");
  const tipo = v("tipo", "categoria", "tipo_transportador", "tipo_pessoa");
  const rntrcOut = v("rntrc", "numero_rntrc", "rntrc_numero") || rntrc;

  const ok = /\b(regular|ativ|valid)\w*/i.test(situacao);

  return {
    rntrc: rntrcOut,
    situacao,
    vencimento,
    transportador,
    cnpj_transportador: cnpjTransp,
    tipo_transportador: tipo,
    ok,
    found: Boolean(rntrcOut || situacao || transportador),
    rawCode,
    rawMessage,
  };
}

// ───────────────────── Consulta Situacao do Veiculo ─────────────────────
// Por placa (+ renavam/uf opcionais). Cascata de produtos no backend:
// detran-{uf}/restricoes-veiculo -> denatran/restricoes-veiculo -> senatran/sinesp-cidadao.

export type VeiculoSituacaoResult = {
  placa: string;
  marca_modelo: string;
  ano_modelo: string;
  cor: string;
  municipio: string;
  uf: string;
  situacao: string;             // ex: "Em Circulacao", "Furto/Roubo", "Apreendido"
  licenciamento_situacao: string; // status do licenciamento
  licenciamento_ano: string;
  licenciamento_validade: string;
  ipva_situacao: string;
  debitos_total: string;
  multas_qtd: string;
  restricoes: string;           // texto livre com restricoes/alertas
  produto_usado: string;
  ok: boolean;                  // true se circulando regularmente
  found: boolean;
  rawCode: number;
  rawMessage: string;
};

export async function consultaVeiculoSituacao(opts: {
  placa: string;
  renavam?: string;
  uf?: string;
}): Promise<VeiculoSituacaoResult> {
  const placa = opts.placa.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (placa.length !== 7) throw new Error("Placa invalida (7 caracteres).");

  const json = await postJson<ConsultaEnvelope & { _produto_usado?: string }>(
    "/api/consulta/veiculo-situacao",
    {
      placa,
      renavam: (opts.renavam ?? "").replace(/\D/g, "") || undefined,
      uf: opts.uf || undefined,
    },
  );

  const rawCode = json.code ?? 0;
  const rawMessage = json.code_message ?? "";

  if (typeof window !== "undefined") {
    if (import.meta.env.DEV) console.debug("[consultaVeiculoSituacao] raw response:", json);
  }

  if (rawCode !== 200) {
    return {
      placa,
      marca_modelo: "",
      ano_modelo: "",
      cor: "",
      municipio: "",
      uf: "",
      situacao: "",
      licenciamento_situacao: "",
      licenciamento_ano: "",
      licenciamento_validade: "",
      ipva_situacao: "",
      debitos_total: "",
      multas_qtd: "",
      restricoes: "",
      produto_usado: "",
      ok: false,
      found: false,
      rawCode,
      rawMessage,
    };
  }

  const v = (...keys: string[]) => consultaValor(json.data, ...keys);
  const situacao = v("situacao", "situacao_veiculo", "status").toUpperCase();
  const licSituacao = v(
    "licenciamento_situacao",
    "situacao_licenciamento",
    "licenciamento_status",
  );
  const restricoes = v(
    "restricoes",
    "restricao",
    "comunicacao_venda",
    "alertas",
    "observacoes",
  );

  // Considera "ok" se nao tem alerta de roubo/furto/apreensao e licenciamento OK
  const ok =
    !!situacao &&
    !/ROUB|FURT|APREEN|BLOQ|RESTRIC/.test(situacao) &&
    !/IRREGULAR|VENCID|ATRAS|PEND/i.test(licSituacao);

  return {
    placa: v("placa", "placa_veiculo") || placa,
    marca_modelo: v("marca_modelo", "marca", "veiculo_marca_modelo"),
    ano_modelo: v("ano_modelo", "ano_modelo_veiculo"),
    cor: v("cor"),
    municipio: v("municipio", "cidade"),
    uf: v("uf", "uf_emplacamento"),
    situacao,
    licenciamento_situacao: licSituacao,
    licenciamento_ano: v("licenciamento_ano", "ano_licenciamento", "exercicio"),
    licenciamento_validade: v(
      "licenciamento_validade",
      "validade_licenciamento",
      "data_licenciamento",
    ),
    ipva_situacao: v("ipva_situacao", "situacao_ipva", "ipva"),
    debitos_total: v("debitos_total", "valor_debitos", "total_debitos"),
    multas_qtd: v("multas", "qtd_multas", "quantidade_multas"),
    restricoes,
    produto_usado: json._produto_usado ?? "",
    ok,
    found: Boolean(situacao || v("marca_modelo")),
    rawCode,
    rawMessage,
  };
}

// ───────────────────── Consulta CEP ─────────────────────

export type CepConsultaResult = {
  cep: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
};

const pick = (row: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

export async function consultaCep(cep: string): Promise<CepConsultaResult> {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) throw new Error("CEP deve ter 8 digitos.");

  // 1) tenta endpoint local (Infosimples via FastAPI)
  let uf = "", cidade = "", bairro = "", logradouro = "";
  try {
    const res = await fetch(`${BASE}/api/consulta/cep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cep: digits }),
    });
    const json = (await res.json()) as ConsultaEnvelope;
    const row = (Array.isArray(json.data) ? json.data[0] : json.data) ?? {};
    if (typeof row === "object" && row !== null) {
      uf = pick(row as Record<string, unknown>, ["uf", "estado"]);
      cidade = pick(row as Record<string, unknown>, ["cidade", "municipio", "localidade"]);
      bairro = pick(row as Record<string, unknown>, ["bairro"]);
      logradouro = pick(row as Record<string, unknown>, ["logradouro", "endereco"]);
    }
  } catch {
    // segue pro fallback
  }

  // 2) fallback ViaCEP (publico, gratuito, CORS aberto)
  if (!uf || !cidade) {
    try {
      const vc = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      if (vc.ok) {
        const v = (await vc.json()) as Record<string, unknown>;
        if (!v.erro) {
          uf = uf || String(v.uf ?? "");
          cidade = cidade || String(v.localidade ?? "");
          bairro = bairro || String(v.bairro ?? "");
          logradouro = logradouro || String(v.logradouro ?? "");
        }
      }
    } catch {
      // sem internet — devolve o que tem
    }
  }

  if (!uf && !cidade) throw new Error("CEP nao encontrado.");
  return { cep: digits, uf, cidade, bairro, logradouro };
}

// ───────────────────── Consulta CNPJ (Receita Federal) ─────────────────────

export type CnpjConsultaResult = {
  nome: string;
  cnpj: string;
  cep: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
  numero: string;
  telefones: string[];
  // ── Situacao Receita Federal ──
  situacao: string;            // ATIVA / SUSPENSA / INAPTA / BAIXADA / NULA
  situacao_data: string;
  situacao_motivo: string;
  abertura_data: string;
  nome_fantasia: string;
  natureza_juridica: string;
  atividade_principal: string;
  atividade_principal_codigo: string;
  capital_social: string;
  porte: string;
  email: string;
  ok: boolean;                 // true se situacao for ATIVA
};

export async function consultaCnpj(cnpj: string): Promise<CnpjConsultaResult> {
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) throw new Error("CNPJ deve ter 14 digitos.");

  const json = await postJson<ConsultaEnvelope>("/api/consulta/cnpj", { cnpj: digits });
  if (json.code !== 200) {
    throw new Error(json.code_message ?? `Erro ${json.code} na consulta CNPJ.`);
  }

  if (typeof window !== "undefined") {
    if (import.meta.env.DEV) console.debug("[consultaCnpj] raw response:", json.data);
  }

  const situacao = consultaValor(
    json.data,
    "situacao",
    "situacao_cadastral",
    "status",
  ).toUpperCase();
  const ok = /^ATIV/.test(situacao);

  return {
    nome: consultaValor(
      json.data,
      "razao_social",
      "nome",
      "nome_empresarial",
      "nome_fantasia",
    ),
    cnpj: consultaValor(json.data, "cnpj", "numero_cnpj", "normalizado_cnpj") || digits,
    cep: consultaValor(
      json.data,
      "endereco_cep",
      "cep",
      "numero_cep",
      "normalizado_endereco_cep",
    ),
    uf: consultaValor(json.data, "endereco_uf", "uf", "estado"),
    cidade: consultaValor(json.data, "endereco_municipio", "municipio", "cidade", "localidade"),
    bairro: consultaValor(json.data, "endereco_bairro", "bairro"),
    logradouro: consultaValor(json.data, "endereco_logradouro", "logradouro", "endereco"),
    numero: consultaValor(json.data, "endereco_numero", "numero", "numero_endereco"),
    telefones: extractPhones(json.data),
    situacao,
    situacao_data: consultaValor(
      json.data,
      "situacao_cadastral_data",
      "normalizado_situacao_cadastral_data",
      "situacao_data",
      "data_situacao_cadastral",
      "data_situacao",
    ),
    situacao_motivo: consultaValor(
      json.data,
      "situacao_cadastral_observacoes",
      "situacao_motivo",
      "motivo_situacao_cadastral",
      "motivo_situacao",
    ),
    abertura_data: consultaValor(
      json.data,
      "abertura_data",
      "normalizado_abertura_data",
      "data_abertura",
      "data_inicio_atividade",
    ),
    nome_fantasia: consultaValor(json.data, "nome_fantasia", "fantasia"),
    natureza_juridica: consultaValor(
      json.data,
      "natureza_juridica",
      "natureza_juridica_descricao",
    ),
    atividade_principal: consultaValor(
      json.data,
      "atividade_economica",
      "atividade_principal",
      "atividade_principal_descricao",
      "cnae_descricao",
      "cnae_principal_descricao",
    ),
    atividade_principal_codigo: consultaValor(
      json.data,
      "atividade_economica_codigo",
      "atividade_principal_codigo",
      "cnae",
      "cnae_codigo",
      "cnae_principal",
    ),
    capital_social: consultaValor(
      json.data,
      "capital_social",
      "normalizado_capital_social",
      "capital",
    ),
    porte: consultaValor(json.data, "porte", "porte_empresa"),
    email: consultaValor(json.data, "email"),
    ok,
  };
}

// ───────────────────── Finalizar cadastro (persistência no sistema) ─────────────────────

/**
 * Envia o cadastro completo para o backend Node.js (persistência em pending_driver_registrations).
 * Sem auth — endpoint público /api/public/cadastro/finalizar.
 */
export async function finalizarCadastro(
  idCadastro: string,
  dados: Record<string, unknown>,
): Promise<{ ok: boolean; id: string }> {
  const res = await fetch("/api/public/cadastro/finalizar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_cadastro: idCadastro, dados }),
  });
  if (!res.ok) {
    let msg = "Erro ao enviar cadastro";
    try {
      const json = (await res.json()) as { message?: string; error?: string };
      msg = json.message || json.error || msg;
    } catch {
      // ignore parse error
    }
    throw new Error(msg);
  }
  return res.json() as Promise<{ ok: boolean; id: string }>;
}

// ───────────────────── RNTRC (comprovante ANTT) ──────────────────────────
// Fase 2 da migracao OCR — provider primario: GPT-4o Vision (sem fallback).

export type RntrcExtracted = {
  rntrc: string;
  documento: string;              // CPF (11) ou CNPJ (14), digits only
  tipo: "PF" | "PJ" | "";
  nome: string;
};

export async function ocrRntrc(
  file: File,
  idCadastro?: string,
): Promise<RntrcExtracted> {
  const imagem = await fileToBase64(file);
  const data = await ocr("/api/ocr/rntrc", imagem, idCadastro);
  const v = (...k: string[]) => ocrValor(data, ...k);
  const onlyDigits = (s: string) => s.replace(/\D/g, "");

  const documento = onlyDigits(v("documento", "cpf_cnpj", "cnpj", "cpf"));
  let tipo: "PF" | "PJ" | "" = "";
  const tipoRaw = v("tipo").toUpperCase();
  if (tipoRaw === "PF" || tipoRaw === "PJ") {
    tipo = tipoRaw;
  } else if (documento.length === 11) {
    tipo = "PF";
  } else if (documento.length === 14) {
    tipo = "PJ";
  }

  return {
    rntrc: onlyDigits(v("rntrc")),
    documento,
    tipo,
    nome: v("nome", "titular", "razao_social"),
  };
}

// ───────────────────── Selfie c/ CNH (anti-fraude) ────────────────────────
// Fase 2 — endpoint novo. GPT-4o Vision valida se o motorista esta segurando
// a propria CNH. Retorna match_score (0-1) + flags de visibilidade.

export type SelfieCnhExtracted = {
  cnh_visible: boolean;
  face_visible: boolean;
  match_score: number | null;      // null quando alguma das faces nao visivel
  nome_cnh_legivel: string;
  observacoes: string;
};

function parseBoolish(raw: string): boolean {
  return raw.trim().toLowerCase() === "true";
}

function parseScore(raw: string): number | null {
  if (!raw || raw.trim().toLowerCase() === "null") return null;
  const n = Number(raw.replace(",", "."));
  if (Number.isNaN(n)) return null;
  return Math.min(1, Math.max(0, n));
}

export async function ocrSelfieCnh(
  file: File,
  idCadastro?: string,
): Promise<SelfieCnhExtracted> {
  const imagem = await fileToBase64(file);
  const data = await ocr("/api/ocr/selfie-cnh", imagem, idCadastro);
  const v = (...k: string[]) => ocrValor(data, ...k);

  return {
    cnh_visible: parseBoolish(v("cnh_visible")),
    face_visible: parseBoolish(v("face_visible")),
    match_score: parseScore(v("match_score")),
    nome_cnh_legivel: v("nome_cnh_legivel"),
    observacoes: v("observacoes"),
  };
}

// ───────────────────── Persistência draft (Supabase Storage) ─────────────────────

/**
 * Resposta do endpoint `POST /api/cadastro/upload-draft-file`.
 *
 * O backend grava o arquivo em `cadastro-drafts/{ownerId}/{cargaId}/{slot}_{ts}.{ext}`
 * (bucket privado) e devolve uma URL assinada com TTL ~24h para preview.
 */
export interface UploadDraftFileResponse {
  storage_path: string;
  signed_url: string;
  slot: string;
  filename: string;
  size: number;
  content_type: string;
  expires_at: string;
}

// Mensagens motorista-friendly — alinhadas com o tom já usado pelo OCR sidecar.
const UPLOAD_DRAFT_GENERIC_ERROR =
  "Não conseguimos guardar esse arquivo agora. Tenta de novo daqui a pouco.";
const UPLOAD_DRAFT_NETWORK_ERROR =
  "Deu problema do nosso lado ao guardar o arquivo. Tenta de novo daqui a pouco.";

/**
 * Envia um arquivo do wizard para o bucket privado `cadastro-drafts` via
 * backend Node.js. Best-effort: cada chamada é independente, falhas não
 * bloqueiam o OCR nem o submit final.
 */
export async function uploadDraftFile(
  file: File,
  slot: string,
  cargaId: string,
  options?: { cpf?: string; accessToken?: string | null },
): Promise<UploadDraftFileResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("slot", slot);
  fd.append("cargaId", cargaId);
  if (options?.cpf) fd.append("cpf", options.cpf);

  const headers: Record<string, string> = {};
  if (options?.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  let res: Response;
  try {
    res = await fetch("/api/cadastro/upload-draft-file", {
      method: "POST",
      headers,
      body: fd,
    });
  } catch (networkError) {
    if (import.meta.env.DEV) {
      console.warn("[uploadDraftFile] network error", networkError);
    }
    throw new Error(UPLOAD_DRAFT_NETWORK_ERROR);
  }

  let json: unknown = null;
  let parseErr = false;
  try {
    json = await res.json();
  } catch {
    parseErr = true;
  }

  if (!res.ok) {
    if (parseErr) {
      throw new Error(
        res.status >= 500 ? UPLOAD_DRAFT_NETWORK_ERROR : UPLOAD_DRAFT_GENERIC_ERROR,
      );
    }
    const detail =
      (json as { message?: unknown; detail?: unknown; error?: unknown }) ?? {};
    const candidate = detail.message ?? detail.detail ?? detail.error;
    throw new Error(extractDetail(candidate, res.status));
  }

  if (parseErr) throw new Error(UPLOAD_DRAFT_GENERIC_ERROR);
  return json as UploadDraftFileResponse;
}

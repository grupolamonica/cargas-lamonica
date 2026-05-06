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
    .flatMap((value) => value.split(/[\/;|,\n]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const digits = value.replace(/\D/g, "");
      return (digits.length === 10 || digits.length === 11) && !/^0+$/.test(digits);
    });

  return [...new Set(normalized)];
}

function extractDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg, type}, ...]
    const msgs = detail
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d === "object" && "msg" in d) return String((d as { msg: unknown }).msg);
        return "";
      })
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      // ignore
    }
  }
  return `Falha na requisicao (HTTP ${status}).`;
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
    throw new Error(json.code_message ?? `Erro ${json.code} ao processar documento.`);
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
    throw new Error(json.code_message ?? `Erro ${json.code} ao processar documento.`);
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

function splitFiliacao(filiacao: string): { pai: string; mae: string } {
  if (!filiacao) return { pai: "", mae: "" };
  const paiLbl = filiacao.match(/(?:PAI|FILIA(?:C|Ç)AO\s+PATERNA)[\s:]+([^\n;|]+?)(?=\n|;|\||$|M[AÃ]E\b)/i);
  const maeLbl = filiacao.match(/(?:M[AÃ]E|FILIA(?:C|Ç)AO\s+MATERNA)[\s:]+([^\n;|]+)/i);
  if (paiLbl && maeLbl) return { pai: paiLbl[1].trim(), mae: maeLbl[1].trim() };
  const linhas = filiacao.split(/\n|;|\|/).map((s) => s.trim()).filter(Boolean);
  if (linhas.length >= 2) return { pai: linhas[0], mae: linhas[1] };
  return { pai: linhas[0] || "", mae: "" };
}

function splitRG(texto: string): { numero: string; orgao: string; uf: string } {
  if (!texto) return { numero: "", orgao: "", uf: "" };
  const m = texto.match(/^([\d.\-Xx]+)\s*([A-Za-z]{2,})?[\s\-/,]*([A-Z]{2})?$/);
  if (m) return { numero: (m[1] || "").trim(), orgao: (m[2] || "").trim(), uf: (m[3] || "").trim() };
  return { numero: texto.trim(), orgao: "", uf: "" };
}

function splitLocal(texto: string): { cidade: string; uf: string } {
  if (!texto) return { cidade: "", uf: "" };
  const m = texto.trim().match(/^(.+?)[\s\-/,]+([A-Z]{2})\s*$/i);
  if (m) return { cidade: m[1].trim(), uf: m[2].trim().toUpperCase() };
  return { cidade: texto.trim(), uf: "" };
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
  const rg = splitRG(v("identidade", "rg"));
  const localCnh = splitLocal(v("local_expedicao", "local", "local_emissao"));
  const localNasc = splitLocal(v("local_nascimento", "naturalidade_local"));

  const validade = v("validade", "data_validade", "vencimento");
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
      nome_pai: filiacao.pai,
      nome_mae: filiacao.mae,
      naturalidade: v("naturalidade") || localNasc.cidade || localCnh.cidade,
      rg: rg.numero,
      rg_orgao: rg.orgao || v("identidade_orgao", "rg_orgao"),
      rg_uf: rg.uf || v("identidade_uf", "rg_uf"),
    },
    cnh: {
      registro: v("registro", "numero_registro"),
      categoria: v("categoria"),
      codigo_seguranca: v("seguranca", "codigo_seguranca", "numero_seguranca"),
      numero_espelho: v("espelho", "numero_espelho"),
      uf_emissor: localCnh.uf || v("uf_expedicao", "uf_emissao", "estado_emissor"),
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
    console.debug("[ocrCrlv] raw response:", data);
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
    throw new Error(json.code_message ?? `Erro ${json.code} ao processar comprovante.`);
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
    console.debug(`[consultaAntt/${estrategia}] raw response:`, { code: rawCode, data: json.data });
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
    console.debug("[consultaVeiculoSituacao] raw response:", json);
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
    console.debug("[consultaCnpj] raw response:", json.data);
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

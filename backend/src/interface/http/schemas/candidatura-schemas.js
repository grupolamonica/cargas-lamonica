import { z } from "zod";

// Placa Mercosul: AAA1A23 (3 letras, 1 digito, 1 letra, 2 digitos).
// Placa antiga: AAA1234 (3 letras, 4 digitos).
// Aceita 7 chars sem hifen apos uppercase.
const plateRegex = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

const plateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(7, "Placa deve ter 7 caracteres.")
  .max(8, "Placa deve ter no maximo 8 caracteres com hifen.")
  .transform((value) => value.replace(/-/g, ""))
  .refine((value) => plateRegex.test(value), {
    message: "Placa fora do padrao Mercosul (ABC1D23) ou antigo (ABC1234).",
  });

// CPF schema: 11 digitos numericos (com ou sem pontuacao — normaliza para digitos).
const cpfSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v.length === 11, { message: "CPF deve ter 11 digitos." });

// CNPJ schema: 14 digitos numericos (com ou sem pontuacao — normaliza para digitos).
const cnpjSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v.length === 14, { message: "CNPJ deve ter 14 digitos." });

/**
 * Schema do POST /api/candidatura/pre-check (endpoint publico — sem session).
 *
 * - cpf: obrigatorio — motoristas nao precisam de login/senha; CPF vem do form.
 * - trailerPlates: 0 a 2 placas (D-08: BITREM = 2 carretas no maximo).
 */
export const candidaturaPreCheckSchema = z.object({
  cpf: cpfSchema,
  horsePlate: plateSchema,
  trailerPlates: z.array(plateSchema).max(2, "Maximo de 2 carretas permitidas.").default([]),
  // preferCache: pula chamadas ao vivo do Angellira (usa só cache/DB). Resgate
  // de rascunho pelo operador usa isto para a tela não travar 30-45s; a
  // validação autoritativa ocorre no submit.
  preferCache: z.boolean().optional().default(false),
});

/**
 * Schema do POST /api/candidatura/draft (plan 03 + Bug-8 hardening).
 *
 * - cargaId obrigatorio (D-10 — wizard sempre tem contexto de carga).
 * - dados livre via passthrough (snapshot do wizard, validacao final no submit).
 * - cpf OPCIONAL: usado pra identificar draft no fluxo PUBLICO (motorista sem
 *   session Supabase). Quando driver session existe, o backend ignora o cpf
 *   do body e usa driver_user_id (anti-tampering D-02).
 * - strict() segue rejeitando driver_user_id no body.
 */
export const candidaturaDraftSchema = z
  .object({
    cargaId: z.string().trim().min(1, "cargaId obrigatorio."),
    cpf: cpfSchema.optional(),
    dados: z.object({}).passthrough(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// W-05 — pre-processor recursivo: remove chaves prefixadas `__` em qualquer
// nivel da arvore. Chaves como `__currentStep` injetadas pelo hook do plan 12
// nao causam ZodError no strict().
//
// Aplicado via z.preprocess(stripPrivateKeys, schema) — antes da validacao.
// ────────────────────────────────────────────────────────────────────────────
/**
 * Iter #7 — mapeamento explicito de path JSON do payload do submit para a
 * "secao do wizard" + label do campo amigavel ao motorista. Usado pelo
 * `buildMissingFieldsMessage` para construir mensagens de erro especificas
 * em vez do generico "Faltam campos obrigatorios. Verifique a secao...".
 *
 * Chaves: regex string do path (sem indices) para suportar arrays (carretas,
 * carreta_owners). Quando aplicavel, indice e injetado via {idx}.
 *
 * Source-of-truth: schemas zod + DriverRegistrationWizard step labels.
 */
export const SUBMIT_PATH_LABEL_MAP = {
  // Motorista (Step A)
  "motorista.nome": "Motorista — Nome",
  "motorista.cpf": "Motorista — CPF",
  "motorista.telefones": "Motorista — Telefones",
  "motorista.telefone_primario": "Motorista — Telefone principal",
  "motorista.endereco.cep": "Motorista — CEP",
  "motorista.endereco.numero": "Motorista — Numero (endereco)",
  "motorista.endereco.logradouro": "Motorista — Logradouro",
  "motorista.endereco.comprovante_storage_path": "Motorista — Comprovante de residencia",
  "motorista.tag_pedagio": "Motorista — Tag de pedagio",
  "motorista.pancary_autodeclaration": "Motorista — Autodeclaracao Pancary",
  "motorista.cnh_url": "Motorista — CNH (upload)",
  "motorista.selfie_cnh_url": "Motorista — Selfie com CNH",
  "motorista.rastreador.empresa": "Motorista — Rastreador (empresa)",
  "motorista.rastreador.login": "Motorista — Rastreador (login)",
  "motorista.rastreador.senha": "Motorista — Rastreador (senha)",
  "motorista.rastreador.id_rastreador": "Motorista — Rastreador (ID)",
  // Cavalo (Step B)
  "cavalo.placa": "Cavalo — Placa",
  "cavalo.crlv_url": "Cavalo — CRLV (upload)",
  "cavalo.owner_doc": "Cavalo — CPF/CNPJ do proprietario",
  "cavalo.cor": "Cavalo — Cor",
  // Proprietario do cavalo (Step C)
  "cavalo_owner.tipo": "Proprietario do cavalo — Tipo (PF/PJ)",
  "cavalo_owner.doc": "Proprietario do cavalo — CPF/CNPJ",
  "cavalo_owner.nome": "Proprietario do cavalo — Nome",
  "cavalo_owner.owner_doc_url": "Proprietario do cavalo — CNH ou cartao CNPJ",
  "cavalo_owner.endereco.cep": "Proprietario do cavalo — CEP",
  "cavalo_owner.endereco.numero": "Proprietario do cavalo — Numero",
  "cavalo_owner.endereco.logradouro": "Proprietario do cavalo — Logradouro",
  "cavalo_owner.endereco.comprovante_storage_path": "Proprietario do cavalo — Comprovante de residencia",
  "cavalo_owner.telefone": "Proprietario do cavalo — Telefone",
  "cavalo_owner.antt_titular.doc": "Titular ANTT do cavalo — CPF/CNPJ",
  "cavalo_owner.antt_titular.nome": "Titular ANTT do cavalo — Nome",
  // Carretas (Step D)
  "carretas.{idx}.placa": "Carreta {idx} — Placa",
  "carretas.{idx}.crlv_url": "Carreta {idx} — CRLV (upload)",
  "carretas.{idx}.owner_doc": "Carreta {idx} — CPF/CNPJ do proprietario",
  // Proprietario carreta (Step E)
  "carreta_owners.{idx}.tipo": "Proprietario da carreta {idx} — Tipo (PF/PJ)",
  "carreta_owners.{idx}.doc": "Proprietario da carreta {idx} — CPF/CNPJ",
  "carreta_owners.{idx}.nome": "Proprietario da carreta {idx} — Nome",
  "carreta_owners.{idx}.owner_doc_url": "Proprietario da carreta {idx} — CNH ou cartao CNPJ",
  "carreta_owners.{idx}.endereco.cep": "Proprietario da carreta {idx} — CEP",
  "carreta_owners.{idx}.endereco.numero": "Proprietario da carreta {idx} — Numero",
  "carreta_owners.{idx}.endereco.logradouro": "Proprietario da carreta {idx} — Logradouro",
  "carreta_owners.{idx}.endereco.comprovante_storage_path": "Proprietario da carreta {idx} — Comprovante de residencia",
  "carreta_owners.{idx}.telefone": "Proprietario da carreta {idx} — Telefone",
};

/**
 * Iter #7 — Converte path zod (ex.: 'dados.cavalo_owner.endereco.comprovante_storage_path')
 * em label amigavel mapeado pelo `SUBMIT_PATH_LABEL_MAP`. Index numerico nos
 * arrays (carretas[0], carreta_owners[1]) e substituido por {idx} (1-based)
 * no template.
 *
 * @param {string} rawPath path do zod issue (dot-separated, com prefixo opcional 'dados.')
 * @returns {string} label amigavel ou o proprio path se nao mapeado.
 */
export function mapSubmitPathToLabel(rawPath) {
  if (!rawPath) return "";
  // Remove prefixo `dados.` do path do zod (ex.: dados.cavalo_owner.X -> cavalo_owner.X).
  const stripped = rawPath.replace(/^dados\./, "");
  // Substitui indices numericos (ex.: carretas.0.placa) por {idx} no template.
  const normalized = stripped.replace(/\.(\d+)\./g, ".{idx}.");
  const indexMatch = stripped.match(/\.(\d+)\./);
  const idx = indexMatch ? Number(indexMatch[1]) + 1 : null;

  const template = SUBMIT_PATH_LABEL_MAP[normalized];
  if (!template) return stripped;
  return idx != null ? template.replace(/\{idx\}/g, String(idx)) : template;
}

/**
 * Iter #7 — Constroi mensagem de erro do submit citando TODAS as secoes/campos
 * faltantes (em vez do generico "Faltam campos obrigatorios").
 *
 * @param {Array<{path: string, message: string}>} issues lista de zod issues.
 * @returns {string} mensagem multi-linha amigavel.
 */
export function buildMissingFieldsMessage(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "Faltam campos obrigatorios. Revise as secoes do cadastro.";
  }
  const seen = new Set();
  const items = [];
  for (const issue of issues) {
    const label = mapSubmitPathToLabel(issue.path);
    if (!seen.has(label)) {
      seen.add(label);
      items.push(label);
    }
  }
  if (items.length === 1) {
    return `Campo obrigatorio faltando: ${items[0]}.`;
  }
  return `Campos obrigatorios faltando (${items.length}):\n${items.map((i) => `• ${i}`).join("\n")}`;
}

export function stripPrivateKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripPrivateKeys);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof k === "string" && k.startsWith("__")) continue;
      out[k] = stripPrivateKeys(v);
    }
    return out;
  }
  return value;
}

// ── Sub-schemas reutilizaveis (motorista, cavalo, carreta, owner) ──────────

const enderecoSchema = z
  .object({
    cep: z.string().trim().min(8).max(9),
    numero: z.string().trim().min(1),
    logradouro: z.string().trim().min(1),
    bairro: z.string().trim().optional(),
    cidade: z.string().trim().optional(),
    uf: z.string().trim().length(2).optional(),
    complemento: z.string().trim().optional(),
    // 2026-05-22 — storage_path do comprovante de residencia persistido no
    // bucket cadastro-drafts. FE envia quando o motorista anexa o documento
    // no Step de endereco. Backend persiste no JSONB pro operador conferir.
    comprovante_storage_path: z.string().trim().min(1).optional(),
  })
  .strict();

const tagPedagioEnum = z.enum([
  "sem_parar",
  "conectcar",
  "move_mais",
  "veloe",
  "eixo_pass",
  "nao_possuo",
]);

const pancaryAutodeclaracaoEnum = z.enum(["sim", "nao", "desconhecido"]);

const rastreadorSchema = z
  .object({
    empresa: z.string().trim().min(1),
    login: z.string().trim().min(1),
    senha: z.string().trim().min(1),
    id_rastreador: z.string().trim().min(1),
  })
  .strict();

const motoristaSchema = z
  .object({
    nome: z.string().trim().min(2),
    cpf: z.string().trim().optional(), // CPF vem da sessao — opcional aqui para nao quebrar shape antigo.
    data_nascimento: z.string().trim().optional(),
    // PLAN-CADASTRO-PARITY — paridade com /cadastro: filiacao + RG (opcionais).
    // Sao opcionais para nao quebrar o fluxo atual do wizard.
    nome_pai: z.string().trim().optional(),
    nome_mae: z.string().trim().optional(),
    naturalidade: z.string().trim().optional(),
    rg: z.string().trim().optional(),
    rg_orgao: z.string().trim().optional(),
    rg_uf: z.string().trim().length(2).optional(),
    // cnh: passthrough — aceita chaves extras (categoria, validade, registro,
    // codigo_seguranca, numero_espelho, uf_emissor, primeira_emissao). As
    // chaves extras vem de paridade com /cadastro (PLAN-CADASTRO-PARITY).
    cnh: z
      .object({
        categoria: z.string().trim().optional(),
        validade: z.string().trim().optional(),
        registro: z.string().trim().optional(),
      })
      .passthrough()
      .optional(),
    telefones: z.array(z.string().trim().min(10)).min(1).max(2),
    telefone_primario: z.string().trim().min(10),
    endereco: enderecoSchema,
    // 19/05 — Antes os campos *_url validavam `z.string().url()`. Frontend
    // emite `storage_path` (path interno do bucket cadastro-drafts, NAO uma
    // URL — signed URLs sao temporarias de 24h). Schema relaxado para
    // `string().min(1)` aceitando paths; operator regenera signed URL on
    // demand a partir do storage_path persistido no JSONB.
    cnh_url: z.string().trim().min(1).optional(),
    comprovante_url: z.string().trim().min(1).optional(),
    selfie_cnh_url: z.string().trim().min(1).optional(),
    // Skip-Step-B fix — tag_pedagio + pancary_autodeclaration sao coletados no
    // Step B do wizard (junto com o cavalo). Quando o Step B e pulado (placa
    // do cavalo ja vigente via Angellira), o submit nao carrega esses campos.
    // Relaxados para optional — handler faz merge com motorista persistido
    // (mergeMotorista/getExistingMotorista) e o operator-admin trata ausencia
    // como "nao coletado" (UI ja suporta).
    tag_pedagio: tagPedagioEnum.optional(),
    pancary_autodeclaration: pancaryAutodeclaracaoEnum.optional(),
    rastreador: rastreadorSchema.optional(),
  })
  .strict();

const ownerDocTypeEnum = z.enum(["cpf", "cnpj"]);

const dadosBancariosSchema = z
  .object({
    banco_compe: z.string().trim().min(1),
    banco_nome: z.string().trim().min(1),
    agencia: z.string().trim().min(1),
    conta: z.string().trim().min(1),
    tipo: z.enum(["corrente", "poupanca"]),
  })
  .strict();

const veiculoCoreSchema = {
  placa: plateSchema,
  renavam: z.string().trim().optional(),
  chassi: z.string().trim().optional(),
  marca: z.string().trim().optional(),
  // `ano` conceitualmente representa o ano-modelo (CRLV). Mantemos o nome
  // por compatibilidade. PLAN-CADASTRO-PARITY: ano_fabricacao adicionado
  // separadamente abaixo.
  ano: z
    .union([z.number(), z.string().trim()])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(1950).max(2100))
    .optional(),
  cor: z.string().trim().optional(),
  owner_doc: z.string().trim().min(11),
  owner_doc_type: ownerDocTypeEnum,
  // storage_path do bucket `cadastro-drafts` (Supabase Storage). Operator
  // regenera signed URL no painel a partir desse path. Aceita qualquer
  // string nao-vazia (paths nao sao URLs).
  crlv_url: z.string().trim().min(1).optional(),
  ocr_fallback_manual: z.boolean().optional(),
  // PLAN-CADASTRO-PARITY — paridade com /cadastro. Todos opcionais para nao
  // quebrar fluxo atual do wizard.
  modelo: z.string().trim().optional(),
  ano_fabricacao: z
    .union([z.number(), z.string().trim()])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(1950).max(2100))
    .optional(),
  tipo: z.string().trim().optional(),
  carroceria: z.string().trim().optional(),
  uf_emplacamento: z.string().trim().length(2).optional(),
  cidade_emplacamento: z.string().trim().optional(),
  eixos: z
    .union([z.number(), z.string().trim()])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(2).max(9))
    .optional(),
  frota: z.enum(["proprio", "agregado", "terceirizado", "frota"]).optional(),
  antt: z.string().trim().optional(),
  ultimo_licenciamento: z.string().trim().optional(),
};

const cavaloSchema = z.object(veiculoCoreSchema).strict();
const carretaSchema = z.object(veiculoCoreSchema).strict();

/**
 * FEAT-ANTT-TITULAR — sub-schema do titular do RNTRC quando difere do
 * proprietario do CRLV (arrendamento etc.). Captura minima: tipo, doc, nome,
 * com endereco/telefone/banco/RNTRC opcionais. Sem CNH (motorista nao precisa
 * fotografar a CNH do titular ANTT).
 */
const anttTitularSchema = z
  .object({
    tipo: z.enum(["pf", "pj"]),
    doc: z.string().trim().min(11),
    nome: z.string().trim().min(1),
    rntrc: z.string().trim().optional(),
    endereco: enderecoSchema.optional(),
    telefone: z.string().trim().optional(),
    dados_bancarios: dadosBancariosSchema.optional(),
    // 2026-05-18 — Campos sociais migrados do ownerSchema. Lamonica paga o
    // detentor do RNTRC (titular ANTT do cavalo); por isso PIS/estado_civil/
    // cor_raca vivem aqui, nao no owner CRLV. Todos opcionais — apenas
    // relevantes quando o caller for titular ANTT do cavalo PF.
    pis: z.string().trim().optional(),
    estado_civil: z.string().trim().optional(),
    cor_raca: z.string().trim().optional(),
    // 2026-05-22 — storage_paths do cartao CNPJ (documento_storage_path) e do
    // comprovante de residencia (comprovante_storage_path) do titular ANTT,
    // persistidos pelo wizard nos slots {cavalo,carreta}_antt_owner_*.
    // Backend persiste no JSONB pro operador conferir os documentos.
    documento_storage_path: z.string().trim().min(1).optional(),
    comprovante_storage_path: z.string().trim().min(1).optional(),
  })
  .strict();

const ownerSchema = z
  .object({
    tipo: z.enum(["pf", "pj"]),
    doc: z.string().trim().min(11),
    nome: z.string().trim().min(1),
    // 2026-05-18 — `dados_bancarios` agora OPCIONAL no owner CRLV (migrou para
    // anttTitularSchema cavalo). Mantido aceitavel como optional para nao
    // quebrar drafts antigos / fluxos legacy.
    dados_bancarios: dadosBancariosSchema.optional(),
    // 2026-05-18 — Campos sociais (pis/cor_raca/estado_civil) migraram para
    // anttTitularSchema. Mantemos opcionais aqui apenas para retrocompat com
    // drafts antigos persistidos antes do refactor.
    pis: z.string().trim().optional(),
    cor_raca: z.string().trim().optional(),
    estado_civil: z.string().trim().optional(),
    endereco: enderecoSchema.optional(),
    telefone: z.string().trim().optional(),
    rntrc: z.string().trim().optional(),
    rntrc_via: z.enum(["antt", "upload"]).optional(),
    cpf_owner_manual: z.boolean().optional(), // CADASTRO-14 — fallback manual
    /**
     * FEAT-ANTT-TITULAR — quando cascade detecta titular_doc != owner_doc,
     * o wizard captura os dados do titular do RNTRC nesse bloco. Quando
     * undefined, assumimos titular ANTT == owner CRLV (caso default).
     */
    antt_titular: anttTitularSchema.optional(),
    // PLAN-CADASTRO-PARITY — paridade com /cadastro (proprietario PF extras).
    // Todos opcionais para nao quebrar fluxo atual do wizard.
    nome_pai: z.string().trim().optional(),
    nome_mae: z.string().trim().optional(),
    naturalidade: z.string().trim().optional(),
    rg: z.string().trim().optional(),
    rg_orgao: z.string().trim().optional(),
    rg_uf: z.string().trim().length(2).optional(),
    situacao_cnh: z.string().trim().optional(),
    tem_cnh: z.boolean().optional(),
    cnh: z
      .object({
        registro: z.string().trim().optional(),
        categoria: z.string().trim().optional(),
        validade: z.string().trim().optional(),
        codigo_seguranca: z.string().trim().optional(),
        numero_espelho: z.string().trim().optional(),
        uf_emissor: z.string().trim().length(2).optional(),
        primeira_emissao: z.string().trim().optional(),
      })
      .passthrough()
      .optional(),
    // PLAN-CADASTRO-PARITY — paridade com /cadastro (proprietario PJ extras).
    inscricao_estadual: z.string().trim().optional(),
    isento_ie: z.boolean().optional(),
    // 19/05 — storage_path do documento do proprietario (CNH PF ou cartao
    // CNPJ PJ) persistido no bucket `cadastro-drafts`. Operator regenera
    // signed URL on demand.
    owner_doc_url: z.string().trim().min(1).optional(),
  })
  .strict();

const dadosSchema = z
  .object({
    // BUG-WALK-08: Step A pode ser pulado pelo wizard em update parcial
    // (ex.: pendencia so CRLV vencido — motorista ja cadastrado). O handler
    // `submit-candidatura` faz merge com o motorista persistido antes da
    // validacao (mergeMotorista/getExistingMotorista). Aceitamos motorista
    // ausente aqui para nao bloquear esse fluxo legitimo; o handler garante
    // que o objeto final esteja completo.
    motorista: motoristaSchema.optional(),
    cavalo: cavaloSchema,
    cavalo_owner: ownerSchema.optional(),
    carretas: z.array(carretaSchema).max(2, "Maximo de 2 carretas (BITREM)."),
    carreta_owners: z.array(ownerSchema).max(2).optional(),
    protocolo: z.string().trim().optional(), // pode existir em re-submit idempotente.
  })
  .strict()
  // Iter #7 — comprovante de residencia obrigatorio para proprietario PF
  // (cavalo + carreta). Aplica-se quando o owner foi enviado (nao reused do
  // motorista). Owners PJ continuam sem essa exigencia.
  .superRefine((data, ctx) => {
    const cavaloOwner = data.cavalo_owner;
    if (cavaloOwner && cavaloOwner.tipo === "pf") {
      if (!cavaloOwner.endereco?.comprovante_storage_path) {
        ctx.addIssue({
          code: "custom",
          path: ["cavalo_owner", "endereco", "comprovante_storage_path"],
          message:
            "Comprovante de residencia obrigatorio para proprietario pessoa fisica do cavalo.",
        });
      }
    }
    if (Array.isArray(data.carreta_owners)) {
      data.carreta_owners.forEach((owner, idx) => {
        if (owner && owner.tipo === "pf") {
          if (!owner.endereco?.comprovante_storage_path) {
            ctx.addIssue({
              code: "custom",
              path: ["carreta_owners", idx, "endereco", "comprovante_storage_path"],
              message:
                "Comprovante de residencia obrigatorio para proprietario pessoa fisica da carreta.",
            });
          }
        }
      });
    }
  });

/**
 * Schema do POST /api/candidatura/submit (plan 07-04).
 *
 * - W-05: pre-processor `stripPrivateKeys` remove chaves __-prefixadas em qualquer nivel.
 * - W-09: refine garante telefone_primario === telefones[0] (anti-divergencia,
 *   worker plan 06 le JSON path simples).
 * - strict() em todos os niveis bloqueia campos nao mapeados (T-07-21b).
 * - CADASTRO-14: aceita ocr_fallback_manual=true (cavalo) e cpf_owner_manual=true (owner)
 *   simultaneamente — o use case decide se a cascata ANTT roda mesmo assim.
 */
export const candidaturaSubmitSchema = z.preprocess(
  stripPrivateKeys,
  z
    .object({
      // cargaId OPCIONAL: candidatura (a partir de uma carga) sempre envia.
      // Cadastro standalone (botao "Cadastro" do /motorista, sem carga) OMITE
      // o campo — o use-case persiste carga_id=NULL. Coluna e TEXT nullable
      // sem FK, entao NULL e estado valido (drafts legacy ja usavam).
      cargaId: z.string().trim().min(1, "cargaId obrigatorio.").optional(),
      dados: dadosSchema,
    })
    .strict()
    .refine(
      (data) => {
        // BUG-WALK-08: quando motorista ausente (Step A pulado), o handler ja
        // hidratou o objeto persistido antes desse refine rodar — mas se ainda
        // assim chegar undefined, deixamos passar; o pos-validacao no use-case
        // detecta motorista faltando.
        const motorista = data?.dados?.motorista;
        if (!motorista) return true;
        return motorista.telefone_primario === motorista.telefones?.[0];
      },
      {
        message: "telefone_primario deve ser igual ao primeiro item de telefones[].",
        path: ["dados", "motorista", "telefone_primario"],
      },
    ),
);

/**
 * Schema do POST /api/candidatura/antt-precheck (W-03).
 * Consumido inline pelo Step C2 do frontend (plan 09) — nao persiste nada.
 */
export const candidaturaAnttPrecheckSchema = z
  .object({
    docType: ownerDocTypeEnum,
    doc: z.string().trim().min(11),
    placa: plateSchema,
  })
  .strict();

/**
 * Schema do POST /api/candidatura/verify-document (Phase 8, plan 08-20).
 *
 * Endpoint PUBLICO (sem driver-auth) com rate limit 5/min/IP. Resposta sempre
 * uniforme (200 com `exists: bool`) para reduzir enumeration de CPF/placa.
 *
 * - type=cpf       → value deve ter 11 digitos (mascara opcional).
 * - type=horsePlate/trailerPlate → value normalizado para uppercase sem
 *   hifen e validado contra plateRegex.
 */
/**
 * Schema do POST /api/cadastro/upload-draft-file (plan 08 — PLAN-DRAFT-FILES).
 *
 * Endpoint multipart — o arquivo em si vem via `req.file` (multer), apenas os
 * metadados auxiliares passam pelo Zod. Auth: driver session OPCIONAL (Bearer)
 * OU CPF no body (fluxo PUBLICO anonimo, mesmo do save-draft-by-cpf).
 *
 * Slot allowlist espelha VALID_DRAFT_SLOTS no use-case upload-draft-file.js.
 */
const VALID_DRAFT_SLOTS_ENUM = z.enum([
  "motorista_cnh",
  "motorista_selfie_cnh",
  "motorista_comprovante",
  "cavalo_crlv",
  "cavalo_antt",
  "cavalo_owner_cnh",
  "cavalo_owner_comprovante",
  "carreta_crlv_0",
  "carreta_crlv_1",
  "carreta_antt_0",
  "carreta_antt_1",
  "carreta_owner_cnh_0",
  "carreta_owner_cnh_1",
  "carreta_owner_comprovante_0",
  "carreta_owner_comprovante_1",
  // ANTT titular — sincronizado com VALID_DRAFT_SLOTS em upload-draft-file.js
  // (2026-05-20). Slots para documento + comprovante do detentor do RNTRC
  // quando difere do dono do CRLV.
  "cavalo_antt_owner_cnh",
  "cavalo_antt_owner_comprovante",
  "carreta_antt_owner_cnh_0",
  "carreta_antt_owner_cnh_1",
  "carreta_antt_owner_comprovante_0",
  "carreta_antt_owner_comprovante_1",
]);

export const uploadDraftFileSchema = z
  .object({
    cargaId: z.string().uuid("cargaId deve ser UUID."),
    slot: VALID_DRAFT_SLOTS_ENUM,
    cpf: cpfSchema.optional(),
  })
  .strict();

export const candidaturaVerifyDocumentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cpf"),
      value: cpfSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("horsePlate"),
      value: plateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("trailerPlate"),
      value: plateSchema,
    })
    .strict(),
  // 2026-05-18 — duplicidade do PROPRIETÁRIO (CRLV cavalo / carreta).
  // Mesmo lookup que `cpf` mas separado para audit log e copy diferente
  // ("proprietario já cadastrado"). `ownerCnpj` adicionado para PJ.
  z
    .object({
      type: z.literal("ownerCpf"),
      value: cpfSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ownerCnpj"),
      value: cnpjSchema,
    })
    .strict(),
]);

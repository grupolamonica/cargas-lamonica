/**
 * buildSubmitDados — converte o formato interno do wizard (stepA/stepB/...)
 * para o shape da API POST /api/candidatura/submit (motorista/cavalo/...).
 *
 * O backend valida com dadosSchema (zod .strict()) — qualquer chave extra
 * fora do contrato é rejeitada com 422.
 */

import type { ConfirmationWizardData } from "./ConfirmationScreen";
import type { StepCData } from "./steps/StepCProprietarioCavalo";
import type { StepEData } from "./steps/StepECarretaOwner";
import type { CollectedCarretaOwner } from "./steps/StepDCarretas";
import type { AnttTitularData } from "./widgets/AnttTitularPrompt";

function digitsOnly(v: string | undefined | null): string {
  return (v ?? "").replace(/\D/g, "");
}

// ── Motorista ────────────────────────────────────────────────────────────────

function buildMotorista(data: ConfirmationWizardData) {
  const a = data.stepA;
  // Bug 7 fix — Step A pode ter sido pulado no wizard (motorista ja cadastrado).
  // Nesse caso o backend (handler /candidatura/submit) merge o motorista persistido
  // antes da validacao. Aqui devolvemos `null` para que o caller omita a chave
  // `motorista` do payload, sinalizando "use o persistido".
  if (!a?.a1 || !a.a2 || !a.a3) return null;

  // 2026-05-16: tag_pedagio / pancary / rastreador agora vivem em stepB
  // (atributos do cavalo). O schema backend ainda os exige sob `motorista`
  // — migração de schema é task separada.
  const b = data.stepB;
  const a6 = b?.a6;
  const rastreador =
    a6 && a6.possui === "sim" && a6.rastreador
      ? {
          empresa: a6.rastreador.empresa,
          login: a6.rastreador.login,
          senha: a6.rastreador.senha,
          id_rastreador: a6.rastreador.id_equipamento,
        }
      : undefined;

  // 2026-05-18 — Filiacao/RG/extras da CNH agora vivem em `a.a1` direto
  // (inlinados via ProgressiveSection no card A1 — sem sub-card A1c).
  const a1 = a.a1;

  return {
    nome: a1.nome,
    cpf: digitsOnly(a1.cpf) || undefined,
    data_nascimento: a1.dataNascimento || undefined,
    // CNH — contrato completo p/ Angellira (bot lê cnh.registro / categoria /
    // codigo_seguranca / uf_emissor / validade / primeira_emissao). Schema
    // backend (motoristaSchema.cnh) é .passthrough(), aceita as chaves extras.
    // 2026-06-01 (DC OCR fix): expandido além de {categoria,validade} —
    // antes registro/codigo_seguranca/numero_espelho/uf_emissor/primeira_emissao
    // eram extraídos pelo A1Cnh mas DROPADOS aqui (perda de dado provider-indep).
    cnh: (() => {
      const cnhObj: Record<string, string> = {};
      if (a1.categoria) cnhObj.categoria = a1.categoria;
      if (a1.validade) cnhObj.validade = a1.validade;
      if (a1.registro) cnhObj.registro = a1.registro;
      if (a1.cnh_codigo_seguranca) cnhObj.codigo_seguranca = a1.cnh_codigo_seguranca;
      if (a1.cnh_numero_espelho) cnhObj.numero_espelho = a1.cnh_numero_espelho;
      if (a1.cnh_uf_emissor) cnhObj.uf_emissor = a1.cnh_uf_emissor;
      if (a1.cnh_primeira_emissao) cnhObj.primeira_emissao = a1.cnh_primeira_emissao;
      return Object.keys(cnhObj).length > 0 ? cnhObj : undefined;
    })(),
    telefones: a.a2.telefones,
    telefone_primario: a.a2.telefone_primario,
    endereco: {
      cep: a.a3.cep,
      numero: a.a3.numero,
      logradouro: a.a3.logradouro,
      bairro: a.a3.bairro || undefined,
      cidade: a.a3.cidade || undefined,
      uf: a.a3.uf || undefined,
    },
    tag_pedagio: b?.a4 || undefined,
    pancary_autodeclaration: b?.a5 || undefined,
    rastreador,
    // 19/05 — storage_path dos documentos do motorista (Supabase Storage).
    // a1.storage_path     -> motorista.cnh_url (CNH frente)
    // a1b.storageUrl      -> motorista.selfie_cnh_url (selfie com CNH)
    // a3.comprovanteUrl   -> motorista.comprovante_url (endereco)
    // Backend regenera signed URL on demand a partir do path.
    ...(a.a1?.storage_path ? { cnh_url: a.a1.storage_path } : {}),
    ...(a.a1b?.storageUrl ? { selfie_cnh_url: a.a1b.storageUrl } : {}),
    ...(a.a3?.comprovanteUrl ? { comprovante_url: a.a3.comprovanteUrl } : {}),
    // PLAN-CADASTRO-PARITY — emite filiacao/RG apenas quando preenchido (todos
    // opcionais no backend; reduzimos ruido no payload). 2026-05-18: lidos de
    // a1 direto (ProgressiveSection inline) em vez do extinto sub-card A1c.
    ...(a1.nome_pai ? { nome_pai: a1.nome_pai } : {}),
    ...(a1.nome_mae ? { nome_mae: a1.nome_mae } : {}),
    ...(a1.naturalidade ? { naturalidade: a1.naturalidade } : {}),
    ...(a1.rg ? { rg: a1.rg } : {}),
    ...(a1.rg_orgao ? { rg_orgao: a1.rg_orgao } : {}),
    ...(a1.rg_uf ? { rg_uf: a1.rg_uf } : {}),
  };
}

// ── Veículo (cavalo ou carreta) ───────────────────────────────────────────────

function buildCavalo(data: ConfirmationWizardData) {
  const b = data.stepB;
  // Step B pode ter sido pulado no wizard quando a placa do cavalo ja tem
  // cadastro vigente (pre-check.completos contem o cavalo). Nesse caso o
  // backend faz merge do veiculo persistido (handler `submit-candidatura`),
  // mas precisa da placa para o lookup. Emitimos um partial { placa } pra
  // que o handler reconheca e busque o resto. Caller (buildSubmitDados)
  // garante que stepB null -> partial cavalo.
  if (!b) return null;

  const docDigits = digitsOnly(b.ownerDoc);
  const ownerDocType: "cpf" | "cnpj" =
    b.ownerDocType === "cnpj" ? "cnpj" : "cpf";

  // PLAN-CADASTRO-PARITY — detalhes opcionais do veiculo (sub-card Bc).
  const bc = b.bc;
  const anoFabricacao = bc?.ano_fabricacao ? Number(bc.ano_fabricacao) : undefined;
  const eixos = bc?.eixos ? Number(bc.eixos) : undefined;

  return {
    placa: b.placa,
    renavam: b.renavam || undefined,
    chassi: b.chassi || undefined,
    marca: b.marca || undefined,
    ano: b.ano ? Number(b.ano) || undefined : undefined,
    cor: b.cor || undefined,
    owner_doc: docDigits,
    owner_doc_type: ownerDocType,
    ocr_fallback_manual: b.ocr_fallback_manual || undefined,
    // 19/05 — storage_path do CRLV do cavalo (bucket cadastro-drafts).
    ...(b.crlvStoragePath ? { crlv_url: b.crlvStoragePath } : {}),
    ...(bc?.modelo ? { modelo: bc.modelo } : {}),
    ...(anoFabricacao && Number.isFinite(anoFabricacao)
      ? { ano_fabricacao: anoFabricacao }
      : {}),
    ...(bc?.tipo ? { tipo: bc.tipo } : {}),
    ...(bc?.carroceria ? { carroceria: bc.carroceria } : {}),
    ...(bc?.uf_emplacamento ? { uf_emplacamento: bc.uf_emplacamento } : {}),
    ...(bc?.cidade_emplacamento
      ? { cidade_emplacamento: bc.cidade_emplacamento }
      : {}),
    ...(eixos && Number.isFinite(eixos) ? { eixos } : {}),
    ...(bc?.ultimo_licenciamento
      ? { ultimo_licenciamento: bc.ultimo_licenciamento }
      : {}),
  };
}

function buildCarretas(data: ConfirmationWizardData) {
  const d = data.stepD;
  if (!d) return [];

  return d.carretas.map((c) => {
    const docDigits = digitsOnly(c.owner_doc);
    const ownerDocType: "cpf" | "cnpj" =
      c.owner_doc_type === "cnpj" ? "cnpj" : "cpf";

    // PLAN-CADASTRO-PARITY — detalhes opcionais da carreta (sub-card Bc).
    const bc = c.bc;
    const anoFabricacao = bc?.ano_fabricacao ? Number(bc.ano_fabricacao) : undefined;
    const eixos = bc?.eixos ? Number(bc.eixos) : undefined;

    return {
      placa: c.plate,
      renavam: c.renavam || undefined,
      chassi: c.chassi || undefined,
      marca: c.marca || undefined,
      ano: c.ano ? Number(c.ano) || undefined : undefined,
      cor: c.cor || undefined,
      owner_doc: docDigits,
      owner_doc_type: ownerDocType,
      ocr_fallback_manual: c.ocr_fallback_manual || undefined,
      // 19/05 — storage_path do CRLV desta carreta (bucket cadastro-drafts).
      ...(c.crlvStoragePath ? { crlv_url: c.crlvStoragePath } : {}),
      ...(bc?.modelo ? { modelo: bc.modelo } : {}),
      ...(anoFabricacao && Number.isFinite(anoFabricacao)
        ? { ano_fabricacao: anoFabricacao }
        : {}),
      ...(bc?.tipo ? { tipo: bc.tipo } : {}),
      ...(bc?.carroceria ? { carroceria: bc.carroceria } : {}),
      ...(bc?.uf_emplacamento ? { uf_emplacamento: bc.uf_emplacamento } : {}),
      ...(bc?.cidade_emplacamento
        ? { cidade_emplacamento: bc.cidade_emplacamento }
        : {}),
      ...(eixos && Number.isFinite(eixos) ? { eixos } : {}),
        ...(bc?.ultimo_licenciamento
        ? { ultimo_licenciamento: bc.ultimo_licenciamento }
        : {}),
    };
  });
}

// ── Owner (cavalo ou carreta) ─────────────────────────────────────────────────

/**
 * FEAT-ANTT-TITULAR — converte AnttTitularData (state interno do wizard) para
 * o shape aceito pelo zod schema (anttTitularSchema). Quando o motorista nao
 * preencheu (sistema confirmou titular == owner CRLV), retorna undefined para
 * que o caller omita a chave (campo eh optional no backend).
 *
 * Endereco so e enviado quando cep + numero + logradouro estiverem completos
 * (enderecoSchema requer esses 3 minimos). Banco so enviado quando todos os
 * 4 campos (bank, agencia, conta, tipo) estiverem preenchidos.
 */
function buildAnttTitularPayload(
  titular: AnttTitularData | null | undefined,
): Record<string, unknown> | undefined {
  if (!titular) return undefined;
  if (!titular.doc || !titular.nome) return undefined;

  const payload: Record<string, unknown> = {
    tipo: titular.tipo,
    doc: digitsOnly(titular.doc),
    nome: titular.nome.trim(),
  };

  if (titular.rntrc) payload.rntrc = titular.rntrc;
  if (titular.telefone) payload.telefone = titular.telefone;

  // 2026-05-18 — Campos sociais migrados do owner CRLV. So PF + cavalo emite
  // os tres; o widget AnttTitularPrompt ja filtra UI por (kind, tipo) — aqui
  // apenas re-emitimos quando presentes (caller no Step C cavalo PF).
  if (titular.pis) payload.pis = titular.pis;
  if (titular.estado_civil) payload.estado_civil = titular.estado_civil;
  if (titular.cor_raca) payload.cor_raca = titular.cor_raca;

  const end = titular.endereco;
  if (end && end.cep && end.numero && end.logradouro) {
    const enderecoPayload: Record<string, unknown> = {
      cep: end.cep,
      numero: end.numero,
      logradouro: end.logradouro,
      bairro: end.bairro || undefined,
      cidade: end.cidade || undefined,
      uf: end.uf || undefined,
    };
    // 2026-05-20 — repassa o storage_path do comprovante salvo no bucket
    // cadastro-drafts. Necessário pro operador conferir o documento.
    if (end.comprovanteUrl) {
      enderecoPayload.comprovante_storage_path = end.comprovanteUrl;
    }
    payload.endereco = enderecoPayload;
  }

  // 2026-05-20 — storage_paths do documento (CNH/cartão CNPJ) do titular
  // ANTT, persistidos nos novos slots cavalo_antt_owner_* e carreta_antt_owner_*.
  if (titular.anttOwnerDocStoragePath) {
    payload.documento_storage_path = titular.anttOwnerDocStoragePath;
  }
  if (titular.anttOwnerComprovanteStoragePath) {
    payload.comprovante_storage_path = titular.anttOwnerComprovanteStoragePath;
  }

  const banco = titular.banco;
  if (banco?.bank && banco.agencia && banco.conta && banco.tipo) {
    payload.dados_bancarios = {
      banco_compe: banco.bank.compe ?? banco.bank.ispb ?? "",
      banco_nome: banco.bank.nome ?? "",
      agencia: banco.agencia,
      conta: banco.conta,
      tipo: banco.tipo,
    };
  }

  return payload;
}

/**
 * Endereço + comprovante de residência do proprietário (cavalo/carreta).
 * O backend EXIGE `owner.endereco.comprovante_storage_path` para proprietário
 * PF (superRefine em dadosSchema). Sem mapear isto, o submit dava 422
 * ("Payload invalido") MESMO com o comprovante anexado — o wizard coletava em
 * `ownerEndereco` mas o payload descartava. Só emite quando cep+numero+
 * logradouro estão presentes (mínimos do enderecoSchema).
 */
function buildOwnerEndereco(
  oe:
    | { cep?: string; numero?: string; logradouro?: string; bairro?: string; cidade?: string; uf?: string; comprovanteUrl?: string }
    | undefined,
  fallbackComprovante?: string,
): Record<string, unknown> | undefined {
  if (!oe || !oe.cep || !oe.numero || !oe.logradouro) return undefined;
  const endereco: Record<string, unknown> = {
    cep: oe.cep,
    numero: oe.numero,
    logradouro: oe.logradouro,
    bairro: oe.bairro || undefined,
    cidade: oe.cidade || undefined,
    uf: oe.uf || undefined,
  };
  const comprovante = oe.comprovanteUrl || fallbackComprovante;
  if (comprovante) endereco.comprovante_storage_path = comprovante;
  return endereco;
}

function buildOwnerFromStepC(stepC: StepCData) {
  const tipo = stepC.owner.docType === "cnpj" ? "pj" : "pf";
  const anttTitular = buildAnttTitularPayload(stepC.anttTitular);

  // 2026-05-18 — Extras PF agora vivem em `owner_extras` (editados inline no
  // OwnerDocumentUploader via ProgressiveSection). Fallback para `ccPF` para
  // drafts antigos que ainda tem dados no campo legado.
  const extras = tipo === "pf" ? stepC.owner_extras ?? stepC.ccPF : undefined;
  const ccPJ = tipo === "pj" ? stepC.ccPJ : undefined;
  const extrasCnh =
    extras?.cnh &&
    Object.values(extras.cnh).some((v) => v && String(v).trim().length > 0)
      ? extras.cnh
      : undefined;

  // 2026-05-18 — Refator: banco/PIS/cor_raca/estado_civil migraram para o
  // anttTitularSchema (cavalo). Owner CRLV emite apenas identidade basica.
  const ownerEndereco = buildOwnerEndereco(stepC.ownerEndereco, stepC.ownerComprovanteStoragePath);

  return {
    tipo,
    doc: digitsOnly(stepC.owner.documento),
    nome: stepC.owner.nome,
    ...(ownerEndereco ? { endereco: ownerEndereco } : {}),
    telefone: stepC.pf?.telefone || undefined,
    rntrc: stepC.antt?.rntrc || undefined,
    rntrc_via: stepC.antt?.rntrc ? ("antt" as const) : undefined,
    cpf_owner_manual: stepC.owner.ocr_fallback_manual || undefined,
    ...(anttTitular ? { antt_titular: anttTitular } : {}),
    // PF extras
    ...(extras?.nome_pai ? { nome_pai: extras.nome_pai } : {}),
    ...(extras?.nome_mae ? { nome_mae: extras.nome_mae } : {}),
    ...(extras?.naturalidade ? { naturalidade: extras.naturalidade } : {}),
    ...(extras?.rg ? { rg: extras.rg } : {}),
    ...(extras?.rg_orgao ? { rg_orgao: extras.rg_orgao } : {}),
    ...(extras?.rg_uf ? { rg_uf: extras.rg_uf } : {}),
    ...(extras?.situacao_cnh ? { situacao_cnh: extras.situacao_cnh } : {}),
    ...(extras && typeof extras.tem_cnh === "boolean"
      ? { tem_cnh: extras.tem_cnh }
      : {}),
    ...(extrasCnh ? { cnh: extrasCnh } : {}),
    // PJ extras
    ...(ccPJ?.inscricao_estadual
      ? { inscricao_estadual: ccPJ.inscricao_estadual }
      : {}),
    ...(ccPJ && typeof ccPJ.isento_ie === "boolean"
      ? { isento_ie: ccPJ.isento_ie }
      : {}),
    ...(ccPJ?.telefone ? { telefone: ccPJ.telefone.replace(/\D/g, "") } : {}),
    // 19/05 — storage_path do documento (CNH PF / cartao CNPJ PJ) do owner.
    ...(stepC.ownerDocStoragePath
      ? { owner_doc_url: stepC.ownerDocStoragePath }
      : {}),
  };
}

function buildOwnerFromCollected(
  collected: CollectedCarretaOwner,
  stepEMap: Record<number, StepEData>,
  idx: number,
) {
  const stepE = stepEMap[idx];
  const tipo = collected.docType === "cnpj" ? "pj" : "pf";

  if (stepE) {
    const anttTitular = buildAnttTitularPayload(stepE.anttTitular);
    // 2026-05-18 — Extras PF agora em `owner_extras` (inline). Fallback p/ ccPF
    // legado de drafts antigos.
    const extras = tipo === "pf" ? stepE.owner_extras ?? stepE.ccPF : undefined;
    const ccPJ = tipo === "pj" ? stepE.ccPJ : undefined;
    const extrasCnh =
      extras?.cnh &&
      Object.values(extras.cnh).some((v) => v && String(v).trim().length > 0)
        ? extras.cnh
        : undefined;
    // 2026-05-18 — Refator: banco/PIS/cor_raca/estado_civil migraram para o
    // anttTitularSchema. Owner CRLV carreta emite apenas identidade basica.
    const ownerEndereco = buildOwnerEndereco(stepE.ownerEndereco, stepE.ownerComprovanteStoragePath);

    return {
      tipo,
      doc: digitsOnly(collected.doc),
      nome: stepE.owner?.nome ?? "",
      ...(ownerEndereco ? { endereco: ownerEndereco } : {}),
      telefone: tipo === "pf" ? stepE.pf?.telefone || undefined : undefined,
      rntrc: stepE.antt?.rntrc || undefined,
      rntrc_via: stepE.antt?.rntrc ? ("antt" as const) : undefined,
      ...(anttTitular ? { antt_titular: anttTitular } : {}),
      // PF extras
      ...(extras?.nome_pai ? { nome_pai: extras.nome_pai } : {}),
      ...(extras?.nome_mae ? { nome_mae: extras.nome_mae } : {}),
      ...(extras?.naturalidade ? { naturalidade: extras.naturalidade } : {}),
      ...(extras?.rg ? { rg: extras.rg } : {}),
      ...(extras?.rg_orgao ? { rg_orgao: extras.rg_orgao } : {}),
      ...(extras?.rg_uf ? { rg_uf: extras.rg_uf } : {}),
      ...(extras?.situacao_cnh ? { situacao_cnh: extras.situacao_cnh } : {}),
      ...(extras && typeof extras.tem_cnh === "boolean"
        ? { tem_cnh: extras.tem_cnh }
        : {}),
      ...(extrasCnh ? { cnh: extrasCnh } : {}),
      // PJ extras
      ...(ccPJ?.inscricao_estadual
        ? { inscricao_estadual: ccPJ.inscricao_estadual }
        : {}),
      ...(ccPJ && typeof ccPJ.isento_ie === "boolean"
        ? { isento_ie: ccPJ.isento_ie }
        : {}),
      ...(ccPJ?.telefone ? { telefone: ccPJ.telefone.replace(/\D/g, "") } : {}),
      // 19/05 — storage_path do documento do proprietario desta carreta.
      ...(stepE.ownerDocStoragePath
        ? { owner_doc_url: stepE.ownerDocStoragePath }
        : {}),
    };
  }

  return {
    tipo,
    doc: digitsOnly(collected.doc),
    nome: "",
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Converte ConfirmationWizardData (formato interno) para o payload
 * `dados` aceito pela API POST /api/candidatura/submit.
 */
export function buildSubmitDados(data: ConfirmationWizardData): Record<string, unknown> {
  const motorista = buildMotorista(data);
  const cavalo = buildCavalo(data);
  const carretas = buildCarretas(data);

  // Step B pulado (cavalo vigente) — emite partial `{ placa }` pra que o
  // backend faca merge com o veiculo persistido (mirror do skip motorista).
  const cavaloPlateFromProps = (data.horsePlate ?? "").trim().toUpperCase();
  const cavaloPayload =
    cavalo ?? (cavaloPlateFromProps ? { placa: cavaloPlateFromProps } : undefined);

  const ownerIsDriver = data.stepB?.ownerIsDriver ?? false;
  const cavalo_owner =
    !ownerIsDriver && data.stepC ? buildOwnerFromStepC(data.stepC) : undefined;

  // BUG-WALK-08: quando a carreta reusa o proprietario do cavalo (mesmo doc),
  // o owner ja esta em `cavalo_owner` — nao duplicar em `carreta_owners`. O
  // backend (carreta.owner_doc) ja aponta pro mesmo doc; carreta_owners[] e
  // somente para docs distintos do cavalo_owner.
  const cavaloOwnerDoc = cavalo_owner?.doc
    ? digitsOnly(cavalo_owner.doc)
    : digitsOnly(data.stepC?.owner.documento || "");
  const carreta_owners: ReturnType<typeof buildOwnerFromCollected>[] = [];
  data.collectedCarretaOwners.forEach((owner, idx) => {
    const ownerDoc = digitsOnly(owner.doc);
    // Skip quando o doc bate com o cavalo_owner (reused_cavalo / driver-owner).
    if (cavaloOwnerDoc && ownerDoc === cavaloOwnerDoc) return;
    if (owner.pfData || owner.pjData) {
      carreta_owners.push(buildOwnerFromCollected(owner, data.stepE, idx));
    }
  });

  // DC-125 — Step A pulado (motorista já conhecido) → buildMotorista=null.
  // No fluxo SEM LOGIN o backend não tem driver_user_id, então precisa do CPF
  // em `dados.motorista.cpf` para hidratar o motorista persistido (handler
  // getExistingMotorista by CPF). Emitimos um partial `{ cpf }` — espelha o
  // partial `{ placa }` do cavalo. Sem isso o submit ia 422 (motorista vazio).
  const motoristaPayload =
    motorista ?? (data.cpf ? { cpf: digitsOnly(data.cpf) } : undefined);

  return {
    ...(motoristaPayload ? { motorista: motoristaPayload } : {}),
    // Step B pulado (cavalo vigente) — envia partial `{ placa }`; backend merge.
    ...(cavaloPayload ? { cavalo: cavaloPayload } : {}),
    ...(cavalo_owner ? { cavalo_owner } : {}),
    carretas,
    ...(carreta_owners.length > 0 ? { carreta_owners } : {}),
  };
}

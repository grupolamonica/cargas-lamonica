/**
 * Converte `pending_driver_registrations.dados` (formato do wizard v2) no
 * formato que o sidecar angelira-bot espera em cada endpoint.
 *
 * Para o sidecar:
 *   - motorista (POST /api/robo/motorista_api/iniciar):
 *       { motorista:{nome,cpf,telefone,rg,rg_uf,nascimento,mae},
 *         cnh:{numero,categoria,validade,primeira_cnh,registro},
 *         endereco:{cep,logradouro,numero,complemento,bairro,cidade,uf} }
 *   - proprietario PF: { cpf, nome, telefone, endereco:{...} }
 *   - proprietario PJ: { cnpj, razao_social, telefone, endereco:{...} }
 *   - veiculo:       { placa, renavam?, chassi?, marca_modelo?, ano_fab?, ... }
 *
 * Epic DC-111 / Sprint 1 / DC-116.
 */

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Normaliza data para BR (DD/MM/YYYY). O bot Angellira aplica `_br_para_iso()`
 * em cima dos campos de data (data_nascimento, validade, primeira_emissao),
 * então SEMPRE entregamos em BR — independente de a origem ser ISO
 * (YYYY-MM-DD, como o wizard grava cnh.validade) ou já BR (como
 * motorista.data_nascimento). Evita o bug de birth/validade chegarem vazios.
 */
function toBrDate(value) {
  if (!value) return "";
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[1]}/${br[2]}/${br[3]}`;
  return s;
}

/**
 * Constrói o payload de cadastro de motorista a partir do `dados` JSONB.
 *
 * @param {object} dados
 * @returns {{motorista:object, cnh:object, endereco:object}}
 */
export function mapMotoristaPayload(dados) {
  const motorista = dados?.motorista || {};
  const cnh = dados?.cnh || motorista.cnh || {};
  const endereco = dados?.endereco || motorista.endereco || {};

  // telefones: o bot lê motorista.telefones[] (→ _phones_para_api). O wizard v2
  // grava o array em motorista.telefones; fallback p/ telefone_primario/telefone.
  const telefonesRaw = Array.isArray(motorista.telefones) && motorista.telefones.length
    ? motorista.telefones
    : [motorista.telefone_primario || motorista.telefone].filter(Boolean);
  const telefones = telefonesRaw.map((t) => digitsOnly(t)).filter(Boolean);

  // IMPORTANTE: as chaves abaixo espelham EXATAMENTE o que o bot lê em
  // angelira_robo/api_query/flow_motorista.py::_construir_payload_driver
  // (data_nascimento, nome_mae, nome_pai, naturalidade, rg_orgao, telefones[],
  // cnh.registro, cnh.uf_emissor, cnh.primeira_emissao). Renomear/dropar essas
  // chaves fazia o preflight do Angellira bloquear com incomplete=['birth'].
  return {
    motorista: {
      nome: String(motorista.nome || "").trim().toUpperCase(),
      cpf: digitsOnly(motorista.cpf),
      // bot faz _br_para_iso(data_nascimento) → entregar em BR DD/MM/YYYY
      data_nascimento: toBrDate(motorista.data_nascimento || motorista.nascimento),
      nome_mae: String(motorista.nome_mae || motorista.mae || "").trim().toUpperCase(),
      nome_pai: String(motorista.nome_pai || motorista.pai || "").trim().toUpperCase(),
      naturalidade: String(motorista.naturalidade || "").trim(),
      rg: String(motorista.rg || motorista.rg_numero || "").trim(),
      rg_orgao: String(motorista.rg_orgao || motorista.rg_orgao_emissor || "").trim().toUpperCase(),
      rg_uf: String(motorista.rg_uf || motorista.rg_estado || "").trim().toUpperCase(),
      telefones,
    },
    cnh: {
      registro: digitsOnly(cnh.registro || cnh.numero || cnh.cnh_numero || cnh.registro_cnh),
      categoria: String(cnh.categoria || cnh.cnh_categoria || "").trim().toUpperCase(),
      codigo_seguranca: digitsOnly(cnh.codigo_seguranca),
      uf_emissor: String(cnh.uf_emissor || cnh.uf || cnh.estado || "").trim().toUpperCase(),
      validade: toBrDate(cnh.validade || cnh.cnh_validade),
      primeira_emissao: toBrDate(
        cnh.primeira_emissao || cnh.primeira_cnh || cnh.primeira_habilitacao,
      ),
    },
    endereco: {
      cep: digitsOnly(endereco.cep),
      logradouro: String(endereco.logradouro || endereco.rua || "").trim().toUpperCase(),
      numero: String(endereco.numero || "").trim(),
      complemento: String(endereco.complemento || "").trim().toUpperCase(),
      bairro: String(endereco.bairro || "").trim().toUpperCase(),
      cidade: String(endereco.cidade || endereco.municipio || "").trim().toUpperCase(),
      uf: String(endereco.uf || endereco.estado || "").trim().toUpperCase(),
    },
  };
}

/**
 * Constrói o payload de cadastro de proprietário (PF ou PJ).
 *
 * @param {object} owner             — dados.cavalo_owner ou dados.carreta_owner[i]
 * @param {string} ownerDocType      — 'cpf' | 'cnpj' (vem do cavalo/carreta)
 * @param {object} fallbackEndereco  — usa endereco do motorista se owner não tiver
 * @returns {{tipo:"PF"|"PJ", payload:object}}
 */
export function mapProprietarioPayload(owner, ownerDocType, fallbackEndereco = {}) {
  if (!owner || typeof owner !== "object") {
    throw new Error("Owner payload ausente — não é possível cadastrar proprietário");
  }
  const tipo = ownerDocType === "cnpj" ? "PJ" : "PF";
  const doc = digitsOnly(owner.doc || owner.cpf || owner.cnpj);
  const endereco = owner.endereco || fallbackEndereco || {};
  const telefone = digitsOnly(
    owner.telefone || owner.telefone_primario
    || (Array.isArray(owner.telefones) ? owner.telefones[0] : "")
  );

  const payload = {
    telefone,
    endereco: {
      cep: digitsOnly(endereco.cep),
      logradouro: String(endereco.logradouro || endereco.rua || "").trim().toUpperCase(),
      numero: String(endereco.numero || "").trim(),
      complemento: String(endereco.complemento || "").trim().toUpperCase(),
      bairro: String(endereco.bairro || "").trim().toUpperCase(),
      cidade: String(endereco.cidade || endereco.municipio || "").trim().toUpperCase(),
      uf: String(endereco.uf || endereco.estado || "").trim().toUpperCase(),
    },
  };

  if (tipo === "PJ") {
    payload.cnpj = doc;
    payload.razao_social = String(owner.razao_social || owner.nome || owner.fantasia || "").trim().toUpperCase();
  } else {
    payload.cpf = doc;
    payload.nome = String(owner.nome || owner.razao_social || "").trim().toUpperCase();
  }

  return { tipo, payload };
}

/**
 * Constrói o payload de cadastro de veículo (cavalo ou carreta).
 *
 * @param {object} veiculo
 * @returns {object} payload pronto pro bot (formato flat)
 */
export function mapVeiculoPayload(veiculo) {
  if (!veiculo || typeof veiculo !== "object") {
    throw new Error("Veículo payload ausente");
  }
  return {
    placa: String(veiculo.placa || "").toUpperCase().trim(),
    renavam: digitsOnly(veiculo.renavam),
    chassi: String(veiculo.chassi || "").toUpperCase().trim(),
    marca_modelo: String(veiculo.marca_modelo || veiculo.marca || "").trim().toUpperCase(),
    ano_fab: Number(veiculo.ano_fab || veiculo.ano_fabricacao) || null,
    ano_modelo: Number(veiculo.ano_modelo) || null,
    cor: String(veiculo.cor || veiculo.cor_veiculo || "").trim().toUpperCase(),
    carroceria: String(veiculo.carroceria || veiculo.tipo_carroceria || "").trim().toUpperCase(),
  };
}

/**
 * Decide se um motorista também é dono do veículo (cavalo). Quando sim, o
 * bot pula o cadastro de proprietário (motorista vira owner via flag
 * `owner:True` no payload do driver) — economia de 1 step.
 */
export function motoristaIsCavaloOwner(dados) {
  const cpf = digitsOnly(dados?.motorista?.cpf);
  const ownerDoc = digitsOnly(dados?.cavalo?.owner_doc);
  return !!cpf && cpf === ownerDoc;
}

/**
 * Helper público — extrai a placa do cavalo / carreta (primeira) de `dados`.
 */
export function extractPlacas(dados) {
  const cavalo = dados?.cavalo?.placa
    ? String(dados.cavalo.placa).toUpperCase().trim()
    : "";
  // carretas pode ser array (wizard v2) ou objeto único legado
  let carreta = "";
  if (Array.isArray(dados?.carretas) && dados.carretas[0]?.placa) {
    carreta = String(dados.carretas[0].placa).toUpperCase().trim();
  } else if (dados?.carreta?.placa) {
    carreta = String(dados.carreta.placa).toUpperCase().trim();
  }
  return { cavalo, carreta };
}

/**
 * Extrai o owner da carreta (suporta carretas[] ou carreta_owner objeto único).
 */
export function extractCarretaOwner(dados, idx = 0) {
  if (Array.isArray(dados?.carreta_owners) && dados.carreta_owners[idx]) {
    return dados.carreta_owners[idx];
  }
  if (dados?.carreta_owner) {
    return dados.carreta_owner;
  }
  return null;
}

/**
 * Extrai o tipo de doc do owner do veículo. Default 'cpf'.
 */
export function extractOwnerDocType(veiculoEntry) {
  return veiculoEntry?.owner_doc_type === "cnpj" ? "cnpj" : "cpf";
}

/**
 * Resolve o proprietário de um veículo no formato do wizard v2, onde o owner
 * vem EMBUTIDO no veículo (dados.cavalo.owner_doc / owner_doc_type /
 * owner_nome) — e NÃO num objeto `dados.cavalo_owner` separado (que o pipeline
 * assumia e nunca existiu, causando PIPELINE_UNEXPECTED em cascata).
 *
 * Resolução de nome (o wizard às vezes grava owner_nome=null):
 *   1. owner_nome explícito;
 *   2. se owner_doc == CPF do motorista → nome do motorista (mesma pessoa, CPF
 *      é identificador único — confiável mesmo se a flag owner_reuse divergir);
 *   3. "" (proprietário terceiro sem nome capturado — gap do wizard).
 *
 * Endereço/telefone: do próprio owner se houver; senão herda do motorista.
 *
 * @param {object} dados
 * @param {object} vehicleEntry  — dados.cavalo ou dados.carretas[i]
 * @returns {null | {doc, doc_type, nome, razao_social?, telefone, endereco, _is_driver}}
 */
export function resolveVehicleOwner(dados, vehicleEntry) {
  if (!vehicleEntry || typeof vehicleEntry !== "object") return null;
  const ownerDoc = digitsOnly(
    vehicleEntry.owner_doc || vehicleEntry.owner_cpf || vehicleEntry.owner_cnpj,
  );
  if (!ownerDoc) return null;

  const docType = (vehicleEntry.owner_doc_type === "cnpj" || ownerDoc.length === 14)
    ? "cnpj"
    : "cpf";
  const motorista = dados?.motorista || {};
  const motoristaCpf = digitsOnly(motorista.cpf);
  const ownerIsDriver = docType === "cpf" && !!motoristaCpf && ownerDoc === motoristaCpf;

  let nome = String(vehicleEntry.owner_nome || vehicleEntry.owner_razao_social || "").trim();
  if (!nome && ownerIsDriver) nome = String(motorista.nome || "").trim();

  const motoristaEndereco = motorista.endereco || dados?.endereco || {};
  const endereco = vehicleEntry.owner_endereco
    || (ownerIsDriver ? motoristaEndereco : null)
    || motoristaEndereco;
  const telefones = Array.isArray(motorista.telefones) ? motorista.telefones : [];
  const telefone = vehicleEntry.owner_telefone
    || (ownerIsDriver ? (motorista.telefone_primario || telefones[0] || "") : "");

  return {
    doc: ownerDoc,
    doc_type: docType,
    nome,
    razao_social: docType === "cnpj"
      ? String(vehicleEntry.owner_razao_social || vehicleEntry.owner_nome || nome).trim()
      : undefined,
    telefone,
    endereco,
    _is_driver: ownerIsDriver,
  };
}

/**
 * owner_reuse.carreta_owners_reused inclui 'cavalo_owner' → a carreta deve
 * reaproveitar o proprietário do cavalo (sem cadastrá-lo de novo).
 */
export function ownerReusesCavalo(dados) {
  const reused = dados?.owner_reuse?.carreta_owners_reused;
  return Array.isArray(reused) && reused.includes("cavalo_owner");
}

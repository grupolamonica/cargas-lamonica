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

function isoToBrDate(iso) {
  // "1990-01-15" → "15/01/1990" (formato que o bot espera)
  if (!iso) return "";
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(iso);
  return `${match[3]}/${match[2]}/${match[1]}`;
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

  const telefonePrimario = motorista.telefone_primario
    || (Array.isArray(motorista.telefones) ? motorista.telefones[0] : "")
    || motorista.telefone
    || "";

  return {
    motorista: {
      nome: String(motorista.nome || "").trim().toUpperCase(),
      cpf: digitsOnly(motorista.cpf),
      telefone: digitsOnly(telefonePrimario),
      rg: String(motorista.rg || motorista.rg_numero || "").trim(),
      rg_uf: String(motorista.rg_uf || motorista.rg_estado || "").trim().toUpperCase(),
      nascimento: isoToBrDate(motorista.nascimento || motorista.data_nascimento),
      mae: String(motorista.mae || motorista.nome_mae || "").trim().toUpperCase(),
    },
    cnh: {
      numero: digitsOnly(cnh.numero || cnh.cnh_numero),
      categoria: String(cnh.categoria || cnh.cnh_categoria || "").trim().toUpperCase(),
      validade: isoToBrDate(cnh.validade || cnh.cnh_validade),
      primeira_cnh: isoToBrDate(cnh.primeira_cnh || cnh.primeira_habilitacao),
      registro: digitsOnly(cnh.registro || cnh.registro_cnh || cnh.numero),
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

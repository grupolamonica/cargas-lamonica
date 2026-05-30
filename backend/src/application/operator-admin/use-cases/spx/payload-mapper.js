/**
 * Converte `pending_driver_registrations.dados` no formato esperado pelo
 * sidecar SPX (`POST /spx/motorista`). Sidecar usa snake_case e exige campos
 * SPX-específicos (contract_type, function_type_list, vehicle_type_name, etc).
 *
 * Notas:
 * - Defaults sensatos para LAMONICA (agency 297): contract_type=364, função
 *   LINE_HAUL (1), vehicle_type=TRUCK
 * - Defaults SOMENTE quando o operador não fornecer override via UI
 * - dry_run=false (cadastro real)
 *
 * Epic DC-111 / extensão SPX.
 */

import { mapMotoristaPayload } from "../angellira/payload-mapper.js";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function birthDayIso(value) {
  // SPX espera "YYYY-MM-DD". Wizard pode mandar "DD/MM/YYYY" ou ISO.
  if (!value) return "1990-01-01";
  const s = String(value).trim();
  // Já ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // BR?
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return s;
}

function cnhValidityIso(value) {
  return birthDayIso(value);
}

// Defaults LAMONICA (agency 297). Configurável via env futuro.
const DEFAULTS = {
  contract_type: Number(process.env.SPX_DEFAULT_CONTRACT_TYPE || 364),
  function_type_list: (process.env.SPX_DEFAULT_FUNCTION_TYPES || "1")
    .split(",").map((s) => Number(s.trim())).filter(Number.isFinite),
  vehicle_type_name: process.env.SPX_DEFAULT_VEHICLE_TYPE || "TRUCK - EXPRESSA",
  gender: 1, // 1=male, 2=female (UI futura pode override via dados.motorista.genero)
};

/**
 * Constrói o MotoristaPayload do bot SPX a partir do `dados` JSONB.
 *
 * @param {object} dados
 * @param {object} [overrides] — overrides do operador (ex: stationName via UI)
 */
export function mapSpxMotoristaPayload(dados, overrides = {}) {
  const ang = mapMotoristaPayload(dados); // reusa normalização do Angellira
  const motorista = dados?.motorista || {};
  const cnh = ang.cnh;
  const endereco = ang.endereco;

  // Genero — wizard pode trazer "M"/"F" em dados.motorista.genero
  const generoRaw = String(motorista.genero || motorista.sexo || "").toUpperCase();
  const gender = generoRaw.startsWith("F") ? 2 : (generoRaw.startsWith("M") ? 1 : DEFAULTS.gender);

  // CNH category SPX (mapeamento simples; bot tem enum K.CNHType)
  const cnhCategoryMap = { A: 1, B: 2, C: 3, D: 4, E: 5, AB: 6, AC: 7, AD: 8, AE: 9 };
  const license_type = cnhCategoryMap[cnh.categoria?.toUpperCase()] || cnhCategoryMap.E;

  // Veículo principal (cavalo)
  const cavalo = dados?.cavalo || {};
  const license_plate = String(cavalo.placa || "").toUpperCase().replace(/\s/g, "");

  return {
    cpf: ang.motorista.cpf,
    driver_name: ang.motorista.nome,
    // mapMotoristaPayload (Angellira) emite `telefones[]` (array) + `cnh.registro`
    // — NÃO `telefone`/`cnh.numero`. Ler as chaves erradas deixava contact_number
    // e license_number undefined → SPX 422 "Field required" pra qualquer motorista.
    contact_number: digitsOnly(
      (Array.isArray(ang.motorista.telefones) && ang.motorista.telefones[0])
        || motorista.telefone_primario || motorista.telefone || "",
    ),
    gender,
    birth_day: birthDayIso(motorista.nascimento || motorista.data_nascimento),

    city_name: endereco.cidade,
    neighbourhood_name: endereco.bairro,
    street_name: endereco.logradouro,
    address_number: endereco.numero,
    zip_code: endereco.cep,

    contract_type: overrides.contract_type ?? DEFAULTS.contract_type,
    function_type_list: overrides.function_type_list ?? DEFAULTS.function_type_list,
    linehaul_station_name: overrides.linehaul_station_name ?? null,
    pickup_station_name: overrides.pickup_station_name ?? null,
    delivery_station_name: overrides.delivery_station_name ?? null,
    return_station_name: overrides.return_station_name ?? null,

    license_number: digitsOnly(cnh.registro || cnh.numero),
    license_type,
    license_expire_date: cnhValidityIso(motorista.cnh_validade || cnh.validade),
    cnh_remarks: overrides.cnh_remarks ?? [],

    vehicle_type_name: overrides.vehicle_type_name ?? DEFAULTS.vehicle_type_name,
    license_plate,
    vehicle_manufacturer: String(cavalo.marca_modelo || cavalo.marca || "").trim().toUpperCase(),
    vehicle_manufacturing_year: String(cavalo.ano_fab || cavalo.ano_fabricacao || ""),
    vehicle_owner_name: String(
      dados?.cavalo_owner?.razao_social || dados?.cavalo_owner?.nome || ang.motorista.nome,
    ).trim().toUpperCase(),
    renavam: digitsOnly(cavalo.renavam),

    // Arquivos opcionais — wizard hoje não passa paths; bot aceita vazio (URLs vazias)
    cnh_frente_path: overrides.cnh_frente_path ?? null,
    cnh_verso_path: overrides.cnh_verso_path ?? null,
    selfie_path: overrides.selfie_path ?? null,
    crlv_path: overrides.crlv_path ?? null,
    risk_doc_path: overrides.risk_doc_path ?? null,
    rad_expire_date: overrides.rad_expire_date ?? null,

    dry_run: overrides.dry_run ?? false,
    do_draft_save: overrides.do_draft_save ?? false,
  };
}
